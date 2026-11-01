import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity, Switch, Alert, Linking } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';
import Constants from 'expo-constants';
import { Screen } from '../../components/Screen';
import { Text } from '../../components/Text';
import { colors, spacing, shapes } from '../../theme/theme';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useAuth } from '../../context/AuthContext';
import { profileService } from '../../services/profile';
import { useSidebar } from '../../context/SidebarContext';
import { useConnectivity } from '../../context/ConnectivityContext';
import { useOfflineData } from '../../context/OfflineDataContext';
import { connectivityStore } from '../../connectivity/connectivityStore';
import { locationBus } from '../../utils/locationBus';
import { formatAge } from '../../utils/geo';
import { OutboxSettings, EmergencyAlertsSettings } from '../../components/OfflineAlertSettings';

const STATE_COLOR = { ONLINE: '#166534', WEAK: '#b26a00', OFFLINE: colors.error };
const STATE_TEXT = { ONLINE: 'Online', WEAK: 'Weak', OFFLINE: 'Offline' };

const formatBytes = (n) => {
    if (!Number.isFinite(n) || n <= 0) return '0 KB';
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
const ago = (ts) => (ts ? formatAge(Date.now() - ts) : 'never');

export const SettingsScreen = () => {
    const navigation = useNavigation();
    const { logout } = useAuth();
    const { toggleDrawer } = useSidebar();
    const conn = useConnectivity();
    const offline = useOfflineData();
    const [notifStatus, setNotifStatus] = useState(null);
    const [locStatus, setLocStatus] = useState(null);
    const [radiusM, setRadiusM] = useState(5000);
    const [checking, setChecking] = useState(false);
    const [profile, setProfile] = useState(null);

    useEffect(() => {
        const loadProfile = () => {
            profileService
                .getProfile()
                .then(data => setProfile(data))
                .catch(() => {});
        };

        loadProfile();
        const unsubscribe = navigation.addListener('focus', loadProfile);
        return unsubscribe;
    }, [navigation]);

    const loadPermissions = useCallback(async () => {
        try {
            setNotifStatus((await Notifications.getPermissionsAsync()).status);
            setLocStatus((await Location.getForegroundPermissionsAsync()).status);
        } catch (e) {
            /* leave as unknown */
        }
    }, []);

    useEffect(() => {
        loadPermissions();
        offline?.refreshStats();
        const unsubscribe = navigation.addListener('focus', () => {
            loadPermissions();
            offline?.refreshStats();
        });
        return unsubscribe;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [navigation, loadPermissions]);

    const here = locationBus.getLast();
    const est = here && offline ? offline.estimate(here.latitude, here.longitude, radiusM) : null;
    const progress = offline?.progress;
    const stats = offline?.stats;

    const startDownload = () => {
        if (!here) return;
        Alert.alert(
            'Download this area',
            `Radius ${radiusM / 1000} km: about ${est.cells.toLocaleString()} risk cells (~${formatBytes(est.riskBytes)}) and nearby places from about ${est.nearbyCenters} lookups (up to ~${est.geoapifyCredits} provider credits). Continue?`,
            [{ text: 'Cancel', style: 'cancel' }, { text: 'Download', onPress: () => offline.downloadArea(here.latitude, here.longitude, radiusM) }]
        );
    };

    const confirmClear = () =>
        Alert.alert(
            'Clear cache',
            'Removes downloaded risk cells and nearby places. Anything recorded offline and not yet uploaded is kept.',
            [{ text: 'Cancel', style: 'cancel' }, { text: 'Clear', style: 'destructive', onPress: () => offline.clearCache() }]
        );

    const checkConnection = async () => {
        setChecking(true);
        try {
            await connectivityStore.checkNow();
        } finally {
            setChecking(false);
        }
    };

    const permissionText = (status) => (status === 'granted' ? 'Allowed' : status === 'denied' ? 'Blocked' : status ? 'Not asked yet' : '...');

    const SettingsRow = ({ icon, title, subtitle, rightElement, onPress }) => (
        <TouchableOpacity 
            style={styles.settingsRow} 
            onPress={onPress}
            activeOpacity={onPress ? 0.7 : 1}
        >
            <View style={styles.iconBox}>
                <Ionicons name={icon} size={20} color={colors.primary} />
            </View>
            <View style={styles.rowText}>
                <Text variant="labelLg" style={{ fontWeight: 'bold' }}>{title}</Text>
                {subtitle && <Text variant="bodyMd" color={colors['on-surface-variant']}>{subtitle}</Text>}
            </View>
            <View style={styles.rightElement}>
                {rightElement || (onPress && <Ionicons name="chevron-forward" size={20} color={colors.outline} />)}
            </View>
        </TouchableOpacity>
    );

    const SectionHeader = ({ title }) => (
        <Text variant="labelSm" color={colors.primary} style={styles.sectionHeader}>{title}</Text>
    );

    return (
        <Screen style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={toggleDrawer} accessibilityLabel="Open menu" style={{ marginRight: spacing.sm }}>
                    <Ionicons name="menu" size={28} color={colors.primary} />
                </TouchableOpacity>
                <Text variant="headlineMd" style={{ fontWeight: 'bold' }}>Settings</Text>
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                
                {/* Profile Card Summary */}
                <TouchableOpacity style={styles.profileCard} onPress={() => navigation.navigate('Profile')}>
                    <View style={styles.avatar}>
                        <Text variant="headlineSm" color={colors.white}>{(profile?.name || 'ST').slice(0, 2).toUpperCase()}</Text>
                    </View>
                    <View style={styles.profileInfo}>
                        <Text variant="headlineSm" style={{ fontWeight: 'bold' }}>{profile?.name || 'SafeTours User'}</Text>
                        <Text variant="bodyMd" color={colors['on-surface-variant']}>Manage account & safety profile</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={20} color={colors.outline} />
                </TouchableOpacity>

                <SectionHeader title="NETWORK & CONNECTION" />
                <View style={styles.sectionCard}>
                    <SettingsRow
                        icon="cellular"
                        title="Connectivity Status"
                        subtitle={(conn.reasons || []).join(' · ') || (conn.lastPingMs ? `Server reply in ${conn.lastPingMs} ms` : 'Checking...')}
                        rightElement={<Text variant="labelMd" style={{ color: STATE_COLOR[conn.state] || colors.error, fontWeight: 'bold' }}>{STATE_TEXT[conn.state] || conn.state}</Text>}
                        onPress={checkConnection}
                    />
                    <View style={styles.divider} />
                    <SettingsRow
                        icon="cloud-offline"
                        title="Offline Mode"
                        subtitle="Test switch: the app behaves as if there is no network (cached data and on-device checks only)"
                        rightElement={
                            <Switch
                                value={Boolean(conn.forced)}
                                onValueChange={(v) => connectivityStore.setForcedOffline(v)}
                                trackColor={{ false: colors.outline, true: colors.primary }}
                            />
                        }
                    />
                </View>
                {checking && <Text variant="labelMd" color={colors['on-surface-variant']} style={{ marginBottom: spacing.sm }}>Checking the server...</Text>}

                <SectionHeader title="PREFERENCES" />
                <View style={styles.sectionCard}>
                    <SettingsRow
                        icon="notifications"
                        title="Notifications"
                        subtitle={`Permission: ${permissionText(notifStatus)}. Alerts, warnings and system updates`}
                        onPress={() => navigation.navigate('Notifications')}
                    />
                    <View style={styles.divider} />
                    <SettingsRow
                        icon="location"
                        title="Location Permission"
                        subtitle={`${permissionText(locStatus)}. Required for live tracking and SOS`}
                        onPress={() => Linking.openSettings()}
                    />
                </View>

                <SectionHeader title="DATA & STORAGE" />
                <View style={styles.sectionCard}>
                    <SettingsRow
                        icon="map"
                        title="Offline risk data"
                        subtitle={stats ? `${stats.risk.cells.toLocaleString()} cells in ${stats.risk.regions} area(s). Updated ${ago(stats.risk.newestFetchedAt)}` : 'Loading...'}
                        rightElement={<Text variant="labelMd" color={colors['on-surface-variant']}>{stats ? formatBytes(stats.risk.bytes) : ''}</Text>}
                    />
                    <View style={styles.divider} />
                    <SettingsRow
                        icon="medkit"
                        title="Offline nearby places"
                        subtitle={stats ? `${stats.nearby.entries} area(s) cached` : 'Loading...'}
                        rightElement={<Text variant="labelMd" color={colors['on-surface-variant']}>{stats ? formatBytes(stats.nearby.bytes) : ''}</Text>}
                    />
                    <View style={styles.divider} />
                    <SettingsRow
                        icon="server"
                        title="Upload queue and database"
                        subtitle={stats ? `${stats.log.waiting || 0} item(s) waiting to upload, ${stats.log.dead || 0} rejected (see Upload queue below)` : 'Loading...'}
                        rightElement={<Text variant="labelMd" color={colors['on-surface-variant']}>{stats ? `DB ${formatBytes(stats.dbBytes)}` : ''}</Text>}
                    />
                    <View style={styles.divider} />
                    <SettingsRow
                        icon="trash-bin"
                        title="Clear Cache"
                        subtitle="Remove downloaded risk cells and nearby places"
                        onPress={confirmClear}
                    />
                </View>

                <OutboxSettings />
                <EmergencyAlertsSettings />

                <SectionHeader title="DOWNLOAD THIS AREA" />
                <View style={[styles.sectionCard, { padding: spacing.md }]}>
                    <Text variant="bodyMd" color={colors['on-surface-variant']} style={{ marginBottom: spacing.sm }}>
                        {here ? 'Saves risk cells and nearby hospitals / police around where you are, for use without data.' : 'Waiting for your location...'}
                    </Text>
                    <View style={styles.radiusRow}>
                        {(offline?.radiiM || []).map((r) => (
                            <TouchableOpacity key={r} style={[styles.radiusChip, radiusM === r && styles.radiusChipOn]} onPress={() => setRadiusM(r)} disabled={progress?.running}>
                                <Text variant="labelMd" color={radiusM === r ? colors.white : colors.primary}>{r / 1000} km</Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                    {est && (
                        <Text variant="labelMd" color={colors['on-surface-variant']} style={{ marginVertical: spacing.sm }}>
                            Estimate: ~{est.cells.toLocaleString()} cells (~{formatBytes(est.riskBytes)}); places need ~{est.nearbyCenters} lookups (up to ~{est.geoapifyCredits} provider credits).
                        </Text>
                    )}
                    {progress?.running ? (
                        <View>
                            <Text variant="labelMd">
                                {progress.phase === 'risk' ? 'Downloading risk cells' : 'Downloading nearby places'}
                                {progress.total ? ` (${progress.done}/${progress.total})` : '...'}
                            </Text>
                            <TouchableOpacity style={[styles.downloadBtn, { backgroundColor: colors.error }]} onPress={offline.cancelDownload}>
                                <Text variant="labelLg" color={colors.white}>Cancel</Text>
                            </TouchableOpacity>
                        </View>
                    ) : (
                        <TouchableOpacity
                            style={[styles.downloadBtn, (!here || conn.state === 'OFFLINE') && { opacity: 0.4 }]}
                            onPress={startDownload}
                            disabled={!here || conn.state === 'OFFLINE'}
                        >
                            <Text variant="labelLg" color={colors.white}>{conn.state === 'OFFLINE' ? 'Go online to download' : 'Download this area'}</Text>
                        </TouchableOpacity>
                    )}
                    {progress?.error && <Text variant="labelMd" color={colors.error} style={{ marginTop: spacing.sm }}>{progress.error}</Text>}
                    {progress?.result && !progress.running && (
                        <Text variant="labelMd" color={colors['on-surface-variant']} style={{ marginTop: spacing.sm }}>
                            {progress.result.aborted
                                ? 'Download cancelled (what was fetched is kept).'
                                : `Saved ${progress.result.risk.cells.toLocaleString()} risk cells${progress.result.risk.truncated ? ' (some tiles were truncated by the server)' : ''}; places stored for ${progress.result.places.stored} of ${progress.result.places.total} spots${progress.result.places.failed ? ` (${progress.result.places.failed} had no data)` : ''}.`}
                        </Text>
                    )}
                </View>

                <SectionHeader title="ABOUT" />
                <View style={styles.sectionCard}>
                    <SettingsRow 
                        icon="information-circle" 
                        title="App Version" 
                        rightElement={<Text variant="labelMd" color={colors['on-surface-variant']}>{`v${Constants.expoConfig?.version || '?'}${Constants.expoConfig?.android?.versionCode ? ` (${Constants.expoConfig.android.versionCode})` : ''}`}</Text>}
                    />
                    <View style={styles.divider} />
                    <SettingsRow 
                        icon="document-text" 
                        title="Terms of Service & Privacy" 
                        onPress={() => Alert.alert(
                            'Terms and Privacy',
                            'SafeTours is a decision aid, not an emergency service: in danger, call 112. Risk levels are estimates from the data shown in the app. Your location, profile, medical details and emergency contacts are stored on the SafeTours server and shared with your contacts only when an SOS is sent. Chat history stays on this phone. Map data © OpenStreetMap contributors; imagery © Esri.'
                        )}
                    />
                </View>

                <TouchableOpacity style={styles.logoutBtn} onPress={logout}>
                    <Text variant="labelLg" color={colors.error} style={{ fontWeight: 'bold' }}>Log Out</Text>
                </TouchableOpacity>

                <View style={{ height: 100 }} />
            </ScrollView>
        </Screen>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.xl,
        paddingBottom: spacing.md,
        backgroundColor: colors.surface,
    },
    scrollContent: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.sm,
    },
    profileCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors['surface-container-low'],
        padding: spacing.md,
        borderRadius: shapes.roundedXl,
        marginBottom: spacing.xl,
        borderWidth: 1,
        borderColor: 'rgba(217, 194, 183, 0.3)',
    },
    avatar: {
        width: 60,
        height: 60,
        borderRadius: 30,
        backgroundColor: colors.tertiary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    profileInfo: {
        flex: 1,
        marginLeft: spacing.md,
    },
    sectionHeader: {
        textTransform: 'uppercase',
        letterSpacing: 1,
        marginBottom: spacing.sm,
        marginLeft: spacing.sm,
        fontWeight: 'bold',
    },
    sectionCard: {
        backgroundColor: colors.white,
        borderRadius: shapes.roundedLg,
        marginBottom: spacing.xl,
        borderWidth: 1,
        borderColor: colors['outline-variant'],
        overflow: 'hidden',
    },
    settingsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: spacing.md,
    },
    iconBox: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: colors['surface-container-high'],
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: spacing.md,
    },
    rowText: {
        flex: 1,
        paddingRight: 4,
    },
    rightElement: {
        marginLeft: spacing.sm,
        justifyContent: 'center',
        alignItems: 'flex-end',
    },
    divider: {
        height: 1,
        backgroundColor: colors['outline-variant'],
        marginLeft: 72,
    },
    radiusRow: { flexDirection: 'row', gap: spacing.sm },
    radiusChip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: shapes.roundedPill, borderWidth: 1, borderColor: colors.primary },
    radiusChipOn: { backgroundColor: colors.primary },
    downloadBtn: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.md, backgroundColor: colors.primary, borderRadius: shapes.roundedPill, marginTop: spacing.sm },
    logoutBtn: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.md,
        backgroundColor: 'rgba(255, 235, 238, 0.5)',
        borderRadius: shapes.roundedPill,
        borderWidth: 1,
        borderColor: 'rgba(186, 26, 26, 0.2)',
        marginTop: spacing.md,
    }
});
