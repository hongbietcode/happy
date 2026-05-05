import React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { UsageBar } from '@/components/usage/UsageBar';
import { useSettingMutable, useEntitlement, useLocalSetting, useLocalSettingMutable, useSetting } from '@/sync/storage';
import { useAuth } from '@/auth/AuthContext';
import { findLanguageByCode, getLanguageDisplayName, LANGUAGES } from '@/constants/Languages';
import { fetchVoiceUsage, type VoiceUsageResponse } from '@/sync/apiVoice';
import { t } from '@/text';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { trackPaywallButtonClicked } from '@/track';
import { getVoiceExperimentStatus, getVoiceUpsellVariantLabel } from '@/realtime/voiceExperiment';
import { getVoiceLocalCounters, resetVoiceLocalCounters } from '@/sync/persistence';

function formatVoiceTime(totalSeconds: number): string {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}m ${secs}s`;
}

export default React.memo(function VoiceSettingsScreen() {
    const router = useRouter();
    const auth = useAuth();
    const [voiceAssistantLanguage] = useSettingMutable('voiceAssistantLanguage');
    const [voiceCustomAgentId, setVoiceCustomAgentId] = useSettingMutable('voiceCustomAgentId');
    const [voiceBypassToken, setVoiceBypassToken] = useSettingMutable('voiceBypassToken');
    const [voiceSourceLanguage, setVoiceSourceLanguage] = useSettingMutable('voiceSourceLanguage');
    const [voiceStopWord, setVoiceStopWord] = useSettingMutable('voiceStopWord');
    const [voiceSonioxApiKey, setVoiceSonioxApiKey] = useSettingMutable('voiceSonioxApiKey');
    const [voiceLlmCorrectionApiKey, setVoiceLlmCorrectionApiKey] = useSettingMutable('voiceLlmCorrectionApiKey');
    const [voiceLlmCorrectionBaseUrl, setVoiceLlmCorrectionBaseUrl] = useSettingMutable('voiceLlmCorrectionBaseUrl');
    const [voiceLlmCorrectionModel, setVoiceLlmCorrectionModel] = useSettingMutable('voiceLlmCorrectionModel');
    const [voiceLlmCorrectionKeywords, setVoiceLlmCorrectionKeywords] = useSettingMutable('voiceLlmCorrectionKeywords');
    const [voiceUpsellOverride, setVoiceUpsellOverride] = useLocalSettingMutable('voiceUpsellOverride');
    const experiments = useSetting('experiments');
    const devModeEnabled = __DEV__ || useLocalSetting('devModeEnabled');

    const hasPro = useEntitlement('pro');

    const [usage, setUsage] = React.useState<VoiceUsageResponse | null>(null);
    const [usageLoading, setUsageLoading] = React.useState(true);
    const [voiceLocalCounters, setVoiceLocalCounters] = React.useState(() => getVoiceLocalCounters());

    React.useEffect(() => {
        if (!auth.credentials) return;
        fetchVoiceUsage(auth.credentials)
            .then(setUsage)
            .catch(() => {})
            .finally(() => setUsageLoading(false));
    }, [auth.credentials]);

    // Find current language or default to first option
    const currentLanguage = findLanguageByCode(voiceAssistantLanguage) || LANGUAGES[0];

    const handleSupportUs = React.useCallback(async () => {
        trackPaywallButtonClicked('voluntary_support');
        await sync.presentPaywall('voluntary_support');
    }, []);

    const promptString = React.useCallback(
        async (title: string, current: string | null, placeholder?: string): Promise<string | null> => {
            const value = await Modal.prompt(title, '', {
                defaultValue: current ?? '',
                placeholder,
            });
            if (value === null) return current;
            const trimmed = value.trim();
            return trimmed === '' ? null : trimmed;
        },
        [],
    );

    const isSonioxSelected = (voiceCustomAgentId ?? '').trim().toLowerCase() === 'soniox';

    const handleCustomAgentId = React.useCallback(async () => {
        const value = await Modal.prompt(
            t('settingsVoice.customAgentId'),
            t('settingsVoice.customAgentIdDescription'),
            {
                defaultValue: voiceCustomAgentId ?? '',
                placeholder: t('settingsVoice.customAgentIdPlaceholder'),
            }
        );
        if (value !== null) {
            const trimmed = value.trim() || null;
            setVoiceCustomAgentId(trimmed);
            // Auto-toggle bypass when setting/clearing agent ID
            setVoiceBypassToken(trimmed !== null);
        }
    }, [voiceCustomAgentId, setVoiceCustomAgentId, setVoiceBypassToken]);

    const handleVoiceExperimentOverride = React.useCallback(() => {
        Modal.alert(
            'Voice Experiment Override',
            'Select a local override for the voice-upsell experiment.',
            [
                { text: 'No Override', onPress: () => setVoiceUpsellOverride(null) },
                { text: 'Control', onPress: () => setVoiceUpsellOverride('control') },
                { text: 'Soft Paywall', onPress: () => setVoiceUpsellOverride('show-paywall-before-first-voice-chat') },
                { text: 'Onboarding + Upsell', onPress: () => setVoiceUpsellOverride('voice-onboarding-and-upsell') },
            ],
        );
    }, [setVoiceUpsellOverride]);

    const handleResetVoiceCounters = React.useCallback(async () => {
        const confirmed = await Modal.confirm(
            'Reset Voice Counters',
            'Clear local voice counters used for onboarding and soft-paywall behavior on this device?',
            {
                confirmText: 'Reset',
                destructive: true,
            },
        );
        if (!confirmed) {
            return;
        }

        resetVoiceLocalCounters();
        setVoiceLocalCounters(getVoiceLocalCounters());
    }, []);

    const voiceExperimentStatus = React.useMemo(() => {
        return getVoiceExperimentStatus({
            voiceBypassToken,
            voiceCustomAgentId,
            voiceUpsellOverride,
            voiceUpsellOverrideEnabled: devModeEnabled,
        });
    }, [devModeEnabled, voiceBypassToken, voiceCustomAgentId, voiceUpsellOverride]);

    const developerExperimentSubtitle = React.useMemo(() => {
        const upsellVariant = getVoiceUpsellVariantLabel(voiceExperimentStatus.upsellVariant);
        const gatingMode = voiceExperimentStatus.gatingMode === 'direct-byo-agent'
            ? 'direct BYO agent bypass'
            : 'Happy server gate';

        return [
            `voice-upsell: ${upsellVariant}`,
            `source: ${voiceExperimentStatus.upsellVariantSource}`,
            `gate: ${gatingMode}`,
            `experiments setting: ${experiments ? 'on' : 'off'}`,
        ].join('\n');
    }, [experiments, voiceExperimentStatus]);

    const developerOverrideLabel = React.useMemo(() => {
        if (!voiceUpsellOverride) {
            return 'No Override';
        }
        return getVoiceUpsellVariantLabel(voiceUpsellOverride);
    }, [voiceUpsellOverride]);

    const developerCountersSubtitle = React.useMemo(() => {
        return [
            `soft paywall shown: ${voiceLocalCounters.softPaywallShownCount}`,
            `onboarding prompt loads: ${voiceLocalCounters.onboardingPromptLoadCount}`,
            `voice messages: ${voiceLocalCounters.voiceMessageCount}`,
        ].join('\n');
    }, [voiceLocalCounters]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Voice Usage */}
            {usageLoading ? (
                <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                    <ActivityIndicator />
                </View>
            ) : usage ? (
                <ItemGroup
                    title={t('settingsVoice.usageTitle')}
                    footer={t('settingsVoice.usageFooter')}
                >
                    <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                        <UsageBar
                            label={t('settingsVoice.usageLabel')}
                            value={usage.usedSeconds}
                            maxValue={usage.limitSeconds}
                            color={usage.usedSeconds >= usage.limitSeconds ? '#FF3B30' : '#007AFF'}
                        />
                        <Text style={{ fontSize: 13, color: '#8E8E93', marginTop: 4 }}>
                            {formatVoiceTime(usage.usedSeconds)} / {formatVoiceTime(usage.limitSeconds)}
                        </Text>
                        <UsageBar
                            label={t('settingsVoice.conversationsLabel')}
                            value={usage.conversationCount}
                            maxValue={usage.conversationLimit}
                            color={usage.conversationCount >= usage.conversationLimit ? '#FF3B30' : '#007AFF'}
                        />
                        <Text style={{ fontSize: 13, color: '#8E8E93', marginTop: 4 }}>
                            {usage.conversationCount} / {usage.conversationLimit}
                        </Text>
                    </View>
                </ItemGroup>
            ) : null}

            {/* Support / Upgrade */}
            {!hasPro && (
                <ItemGroup>
                    <Item
                        title={t('settingsVoice.supportTitle')}
                        subtitle={t('settingsVoice.supportSubtitle')}
                        icon={<Ionicons name="heart-outline" size={29} color="#FF2D55" />}
                        onPress={handleSupportUs}
                    />
                </ItemGroup>
            )}

            {devModeEnabled && (
                <ItemGroup
                    title="Developer"
                    footer="Developer-only diagnostics and local override controls for the current voice rollout. The paid voice gate runs through Happy server unless Direct Connection and a custom ElevenLabs agent are both enabled."
                >
                    <Item
                        title="Voice Experiment Override"
                        subtitle="Simple local override for the voice-upsell flag"
                        detail={developerOverrideLabel}
                        icon={<Ionicons name="options-outline" size={29} color="#007AFF" />}
                        onPress={handleVoiceExperimentOverride}
                    />
                    <Item
                        title="Voice Experiment Status"
                        subtitle={developerExperimentSubtitle}
                        subtitleLines={0}
                        icon={<Ionicons name="flask-outline" size={29} color="#5856D6" />}
                        showChevron={false}
                        copy={developerExperimentSubtitle}
                    />
                    <Item
                        title="Reset Voice Counters"
                        subtitle={developerCountersSubtitle}
                        subtitleLines={0}
                        icon={<Ionicons name="refresh-outline" size={29} color="#FF9500" />}
                        onPress={handleResetVoiceCounters}
                    />
                </ItemGroup>
            )}

            {/* Language Settings */}
            <ItemGroup
                title={t('settingsVoice.languageTitle')}
                footer={t('settingsVoice.languageDescription')}
            >
                <Item
                    title={t('settingsVoice.preferredLanguage')}
                    subtitle={t('settingsVoice.preferredLanguageSubtitle')}
                    icon={<Ionicons name="language-outline" size={29} color="#007AFF" />}
                    detail={getLanguageDisplayName(currentLanguage)}
                    onPress={() => router.push('/settings/voice/language')}
                />
            </ItemGroup>

            {/* Bring Your Own Agent */}
            <ItemGroup
                title={t('settingsVoice.byoTitle')}
                footer={t('settingsVoice.byoDescription')}
            >
                <Item
                    title={t('settingsVoice.customAgentId')}
                    subtitle={voiceCustomAgentId ?? t('settingsVoice.customAgentIdNotSet')}
                    icon={<Ionicons name="key-outline" size={29} color="#FF9500" />}
                    onPress={handleCustomAgentId}
                />
                <Item
                    title={t('settingsVoice.bypassToken')}
                    subtitle={t('settingsVoice.bypassTokenSubtitle')}
                    icon={<Ionicons name="flash-outline" size={29} color="#FF3B30" />}
                    rightElement={
                        <Switch
                            value={voiceBypassToken}
                            onValueChange={setVoiceBypassToken}
                        />
                    }
                />
            </ItemGroup>

            {/* Prompt Guide — shown when custom agent is configured */}
            {voiceCustomAgentId && !isSonioxSelected && (
                <ItemGroup
                    title={t('settingsVoice.promptGuideTitle')}
                    footer={t('settingsVoice.promptGuideDescription')}
                >
                    <Item
                        title={t('settingsVoice.customAgentId')}
                        subtitle={voiceCustomAgentId}
                        copy={voiceCustomAgentId}
                    />
                </ItemGroup>
            )}

            {/* Soniox Provider — active when voiceCustomAgentId === "soniox" */}
            {isSonioxSelected && (
                <ItemGroup
                    title="Soniox STT"
                    footer="Switch voice to Soniox speech-to-text. The transcript is sent to the active session as a single message; no live agent. Client connects directly to Soniox using your API key — no server proxy."
                >
                    <Item
                        title="Soniox API Key"
                        subtitle={voiceSonioxApiKey ? '•••' + voiceSonioxApiKey.slice(-4) : 'Not set'}
                        icon={<Ionicons name="key-outline" size={29} color="#FF3B30" />}
                        onPress={async () => {
                            const v = await promptString('Soniox API key', voiceSonioxApiKey, 'sx-...');
                            setVoiceSonioxApiKey(v);
                        }}
                    />
                    <Item
                        title="Source language"
                        subtitle={voiceSourceLanguage ?? 'auto'}
                        icon={<Ionicons name="language-outline" size={29} color="#34C759" />}
                        onPress={async () => {
                            const v = await promptString('Source language (e.g. en, vi, auto)', voiceSourceLanguage, 'auto');
                            setVoiceSourceLanguage(v);
                        }}
                    />
                    <Item
                        title="Stop word"
                        subtitle={voiceStopWord ?? 'Disabled'}
                        icon={<Ionicons name="hand-left-outline" size={29} color="#FF9500" />}
                        onPress={async () => {
                            const v = await promptString('Stop word (e.g. "send", "stop")', voiceStopWord, 'send');
                            setVoiceStopWord(v);
                        }}
                    />
                </ItemGroup>
            )}

            {/* LLM Correction — usable with Soniox */}
            {isSonioxSelected && (
                <ItemGroup
                    title="LLM correction"
                    footer="Optional: when API key and model are set, the Soniox transcript is cleaned up through an OpenAI-compatible chat-completions API before sending. Base URL defaults to OpenAI. Keywords and the last 5 messages of the active session are passed as context to disambiguate proper nouns and references."
                >
                    <Item
                        title="Base URL"
                        subtitle={voiceLlmCorrectionBaseUrl ?? 'https://api.openai.com/v1 (default)'}
                        icon={<Ionicons name="link-outline" size={29} color="#007AFF" />}
                        onPress={async () => {
                            const v = await promptString('OpenAI-compatible base URL', voiceLlmCorrectionBaseUrl, 'https://api.openai.com/v1');
                            setVoiceLlmCorrectionBaseUrl(v);
                        }}
                    />
                    <Item
                        title="Model"
                        subtitle={voiceLlmCorrectionModel ?? 'Not set'}
                        icon={<Ionicons name="cube-outline" size={29} color="#007AFF" />}
                        onPress={async () => {
                            const v = await promptString('Model name', voiceLlmCorrectionModel, 'gpt-4o-mini');
                            setVoiceLlmCorrectionModel(v);
                        }}
                    />
                    <Item
                        title="API Key"
                        subtitle={voiceLlmCorrectionApiKey ? '•••' + voiceLlmCorrectionApiKey.slice(-4) : 'Not set'}
                        icon={<Ionicons name="key-outline" size={29} color="#FF3B30" />}
                        onPress={async () => {
                            const v = await promptString('API key', voiceLlmCorrectionApiKey, 'sk-...');
                            setVoiceLlmCorrectionApiKey(v);
                        }}
                    />
                    <Item
                        title="Keywords"
                        subtitle={voiceLlmCorrectionKeywords ?? 'None'}
                        subtitleLines={0}
                        icon={<Ionicons name="pricetags-outline" size={29} color="#34C759" />}
                        onPress={async () => {
                            const v = await promptString(
                                'Correction keywords',
                                voiceLlmCorrectionKeywords,
                                'e.g. Soniox, ElevenLabs, Claude, Codex, Tri',
                            );
                            setVoiceLlmCorrectionKeywords(v);
                        }}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
});
