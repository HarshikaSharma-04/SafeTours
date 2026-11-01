import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Image, Platform } from 'react-native';
import { Screen } from '../../components/Screen';
import { Text } from '../../components/Text';
import { GlassCard, InfoCard } from '../../components/ReusableCards';
import { SOSButton } from '../../components/SOSButton';
import { IconText } from '../../components/IconText';
import { Chip } from '../../components/Chip';
import { colors, spacing, typography, shapes } from '../../theme/theme';
import { dashboardService } from '../../services/dashboard';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useAuth } from '../../context/AuthContext';
import { useSidebar } from '../../context/SidebarContext';
import * as Location from 'expo-location';
import { profileService } from '../../services/profile';
import { formatScore, confidenceText, dataQualityNote, factorLabel } from '../../utils/riskLevels';
import { getRiskColors } from '../../components/MapComponent';
import { NearbyServicesCard } from '../../components/NearbyServicesCard';
import { SafetyTips } from '../../components/SafetyTips';
import { ensureWatching, getBestPosition } from '../../utils/locationWatcher';
import { shareLocation } from '../../utils/shareLocation';
import { useConnectivity } from '../../context/ConnectivityContext';
import { formatAge } from '../../utils/geo';
import { useOutbox } from '../../context/OutboxContext';

const STATE_STYLE = {
    ONLINE: { label: 'ONLINE', color: colors.tertiary, detail: 'Connected' },
    WEAK: { label: 'WEAK', color: '#b26a00', detail: 'Weak connection' },
    OFFLINE: { label: 'OFFLINE', color: colors.error, detail: 'Offline' },
};

const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'Good Morning';
    if (hour >= 12 && hour < 17) return 'Good Afternoon';
    if (hour >= 17 && hour < 21) return 'Good Evening';
    return 'Good Night';
};

export const HomeScreen = () => {
    const navigation = useNavigation();
    const { user } = useAuth();
    const { toggleDrawer } = useSidebar();
    const conn = useConnectivity();
    const { summary: outboxSummary } = useOutbox();
    const locationRef = useRef(null);
    const firstRun = useRef(true);
    const [data, setData] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [profile, setProfile] = useState(null);

    // Backend-owned risk for the real location. When the server cannot be reached the risk service answers from
    // the on-device cache (source 'device') and the card says so.
    const loadDashboard = useCallback(async () => {
        try {
            if (!locationRef.current) {
                const { status } = await Location.requestForegroundPermissionsAsync();
                if (status !== 'granted') {
                    throw new Error('Location permission is required to load your safety summary.');
                }
                ensureWatching();
                const location = await getBestPosition();
                if (!location) {
                    throw new Error('Your location is not available yet. Turn on GPS and pull back to this screen.');
                }
                locationRef.current = location.coords;
            }
            const { latitude, longitude } = locationRef.current;
            setData(await dashboardService.getDashboardData(latitude, longitude));
            setLoadError(null);
        } catch (error) {
            console.warn('Dashboard load error:', error);
            setLoadError(error.message || 'Could not load your safety summary.');
        }
    }, []);

    useEffect(() => {
        loadDashboard();
    }, [loadDashboard]);

    // Reload when connectivity changes between OFFLINE and reachable (fresh server data / cached data).
    useEffect(() => {
        if (firstRun.current) {
            firstRun.current = false;
            return;
        }
        loadDashboard();
    }, [conn.isOffline, loadDashboard]);

    useEffect(() => {
        // Read the existing authenticated profile so the greeting uses the person's actual name.
        profileService.getProfile().then(setProfile).catch(error => {
            console.warn('Profile name load error:', error);
        });
    }, []);

    const net = STATE_STYLE[conn.state] || STATE_STYLE.OFFLINE;
    const fromDevice = data?.source === 'device';
    // Display the authenticated profile name; usernames are not presented as a name fallback.
    const displayName = profile?.name || profile?.firstName || profile?.fullName
        || user?.name || user?.firstName || user?.fullName || 'Traveler';

    if (!data && !loadError) {
        return (
            <Screen style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={colors.primary} />
            </Screen>
        );
    }

    return (
        <Screen style={styles.container}>
            {/* Top Navigation */}
            <View style={styles.header}>
                <View style={styles.headerLeft}>
                    <TouchableOpacity onPress={toggleDrawer} accessibilityLabel="Open menu">
                        <Ionicons name="menu" size={28} color={colors.primary} />
                    </TouchableOpacity>
                    <Ionicons name="shield-checkmark" size={24} color={colors.primary} />
                    <Text variant="headlineMd" style={styles.headerTitle}>SafeTours</Text>
                </View>
                <View style={styles.headerRight}>
                    <View style={[styles.onlineBadge, conn.state !== 'ONLINE' && { backgroundColor: `${net.color}22` }]}>
                        <View style={[styles.onlineDot, { backgroundColor: net.color }]} />
                        <Text variant="labelMd" style={[styles.onlineText, { color: net.color }]}>{net.label}</Text>
                    </View>
                    <TouchableOpacity style={styles.profilePicContainer} onPress={() => navigation.navigate('Profile')}>
                        {user?.profileImage
                            ? <Image source={{ uri: user.profileImage }} style={styles.profilePic} />
                            : <Ionicons name="person" size={20} color={colors.primary} />}
                    </TouchableOpacity>
                </View>
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                
                {/* Greeting */}
                <View style={styles.greetingSection}>
                    <Text variant="bodyMd" color={colors['on-surface-variant']}>{getGreeting()},</Text>
                    <Text variant="headlineLg" style={styles.greetingName}>{displayName}</Text>
                    <Text variant="bodyMd" color={colors.primary} style={styles.greetingSub}>Your safety summary for today.</Text>
                </View>

                {loadError ? (
                    <InfoCard style={styles.heroCard}>
                        <Text variant="bodyMd" color={colors.error}>{loadError}</Text>
                        <TouchableOpacity onPress={loadDashboard} style={{ marginTop: spacing.sm }}>
                            <Text variant="labelLg" color={colors.primary} style={{ fontWeight: 'bold' }}>Try again</Text>
                        </TouchableOpacity>
                    </InfoCard>
                ) : (
                    <GlassCard style={styles.heroCard}>
                        <View style={styles.heroHeader}>
                            <Text variant="headlineSm" color={colors['on-surface']}>Area Safety</Text>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                                <Chip label={getRiskColors(data.risk?.riskLevel).label} variant="info" />
                            </View>
                        </View>
                        <View style={styles.heroBody}>
                            <View style={styles.scoreCircle}>
                                <Text style={styles.scoreText}>{formatScore(data.risk?.totalRiskScore)}</Text>
                                {data.risk?.totalRiskScore != null && <Text style={styles.scoreMax}>/100</Text>}
                            </View>
                            <Text variant="bodyMd" color={colors['on-surface-variant']} style={styles.scoreDesc}>
                                {data.risk?.riskLevel === 'UNKNOWN'
                                    ? 'We do not have enough data for this area yet.'
                                    : `Current risk level: ${data.risk?.riskLevel}`}
                                {data.risk?.topFactor ? ` · Main factor: ${factorLabel(data.risk.topFactor)}` : ''}
                            </Text>
                            {confidenceText(data.risk) && (
                                <Text variant="labelMd" color={colors['on-surface-variant']}>
                                    Data confidence: {confidenceText(data.risk)}
                                </Text>
                            )}
                            <Text variant="labelMd" color={fromDevice ? colors.error : colors['on-surface-variant']}>
                                {fromDevice ? 'Offline check · ' : ''}Risk data updated {formatAge(Date.now() - (data.fetchedAt || Date.now())) || 'just now'}
                            </Text>
                            {dataQualityNote(data.risk) && (
                                <Text variant="labelMd" color={data.risk?.lowConfidence ? colors.error : colors['on-surface-variant']}>
                                    {dataQualityNote(data.risk)}
                                </Text>
                            )}
                        </View>
                    </GlassCard>
                )}

                {/* Upload queue: what is waiting, when the last upload was, and anything the server rejected */}
                {(outboxSummary.waiting > 0 || outboxSummary.dead > 0) && (
                    <InfoCard style={styles.heroCard}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                            <Ionicons name={outboxSummary.dead > 0 ? 'alert-circle' : 'cloud-upload'} size={22} color={outboxSummary.dead > 0 ? colors.error : colors.primary} />
                            <View style={{ flex: 1 }}>
                                <Text variant="labelLg" style={{ fontWeight: 'bold' }}>
                                    {outboxSummary.waiting} item{outboxSummary.waiting === 1 ? '' : 's'} waiting to upload
                                    {outboxSummary.dead > 0 ? `, ${outboxSummary.dead} rejected` : ''}
                                </Text>
                                <Text variant="labelMd" color={colors['on-surface-variant']}>
                                    Last upload: {outboxSummary.lastSyncAt ? formatAge(Date.now() - outboxSummary.lastSyncAt) || 'just now' : 'never'}
                                    {outboxSummary.dead > 0 ? '. Open Settings to retry or discard them.' : conn.isOffline ? '. They upload when you are back online.' : '.'}
                                </Text>
                            </View>
                        </View>
                    </InfoCard>
                )}

                {/* Weather & Connectivity Row */}
                <View style={styles.rowCards}>
                    <InfoCard style={styles.halfCard}>
                        <View style={styles.halfCardHeader}>
                            <Ionicons name="partly-sunny" size={24} color={colors.primary} />
                            <Text variant="headlineMd" style={styles.halfCardValue}>{data?.weather?.temperature ?? '—'}{data?.weather?.temperature != null ? '°C' : ''}</Text>
                        </View>
                        <Text variant="labelMd" color={colors['on-surface-variant']}>{data?.weather?.weatherDescription || 'Weather unavailable'}</Text>
                    </InfoCard>
                    <InfoCard style={styles.halfCard}>
                        <View style={styles.halfCardHeader}>
                            <Ionicons name={conn.isOffline ? 'cloud-offline' : 'wifi'} size={24} color={net.color} />
                            <Text variant="headlineMd" style={styles.halfCardValue}>{net.detail}</Text>
                        </View>
                        <Text variant="labelMd" color={colors['on-surface-variant']}>
                            {conn.forced ? 'Offline mode is ON (Settings)' : (conn.netType && conn.netType !== 'unknown' ? conn.netType : 'Unknown network')}
                        </Text>
                    </InfoCard>
                </View>


                <SafetyTips data={data} />

                <NearbyServicesCard />

                {/* Quick Actions */}
                <View style={styles.quickActions}>
                    <Text variant="headlineSm" style={styles.sectionTitle}>Quick Actions</Text>
                    <View style={styles.actionGrid}>
                        <TouchableOpacity style={styles.actionBtn} onPress={() => shareLocation(locationRef.current)}>
                            <View style={styles.actionIconWrapper}>
                                <Ionicons name="location" size={24} color={colors.primary} />
                            </View>
                            <Text variant="labelMd">Share Location</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.actionBtn} onPress={() => navigation.navigate('EmergencyContacts')}>
                            <View style={styles.actionIconWrapper}>
                                <Ionicons name="people" size={24} color={colors.primary} />
                            </View>
                            <Text variant="labelMd">Contacts</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.actionBtn} onPress={() => navigation.navigate('MedicalId')}>
                            <View style={styles.actionIconWrapper}>
                                <Ionicons name="medkit" size={24} color={colors.primary} />
                            </View>
                            <Text variant="labelMd">Medical ID</Text>
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Spacing for floating button */}
                <View style={{ height: 100 }} />
            </ScrollView>

            {/* Floating SOS Button */}
            <View style={styles.floatingSosContainer}>
                <SOSButton onPress={() => navigation.navigate('SOS', { triggerRequestId: Date.now() })} size={64} style={styles.floatingSos} />
            </View>
        </Screen>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.surface,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: colors.surface,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        backgroundColor: 'rgba(255, 248, 246, 0.9)',
        borderBottomWidth: 1,
        borderBottomColor: colors['surface-variant'],
        zIndex: 10,
    },
    headerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    headerTitle: {
        color: colors.primary,
        fontWeight: 'bold',
        flexShrink: 1,
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        flexShrink: 0,
    },
    onlineBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(0, 105, 110, 0.1)',
        paddingHorizontal: spacing.sm,
        paddingVertical: 4,
        borderRadius: shapes.roundedPill,
        borderWidth: 1,
        borderColor: 'rgba(0, 105, 110, 0.2)',
    },
    onlineDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: colors.tertiary,
        marginRight: 6,
    },
    onlineText: {
        color: colors.tertiary,
        fontWeight: '600',
    },
    offlineBadge: {
        backgroundColor: colors['error-container'] || '#ffdad6',
        borderColor: 'rgba(186, 26, 26, 0.25)',
    },
    offlineDot: { backgroundColor: colors.error },
    offlineText: { color: colors.error },
    profilePicContainer: {
        width: 40,
        height: 40,
        borderRadius: 20,
        borderWidth: 2,
        borderColor: colors['primary-container'],
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors['surface-container-low'],
    },
    profilePic: {
        width: '100%',
        height: '100%',
        resizeMode: 'cover',
    },
    scrollContent: {
        padding: spacing.lg,
    },
    greetingSection: {
        marginBottom: spacing.xl,
    },
    greetingName: {
        fontSize: 32,
        color: colors['on-surface'],
        fontWeight: 'bold',
        letterSpacing: -0.5,
    },
    greetingSub: {
        marginTop: 4,
    },
    heroCard: {
        backgroundColor: colors['surface-container-lowest'],
        marginBottom: spacing.lg,
        borderWidth: 1,
        borderColor: colors['surface-variant'],
    },
    heroHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: spacing.md,
    },
    heroBody: {
        alignItems: 'flex-start',
    },
    scoreCircle: {
        flexDirection: 'row',
        alignItems: 'baseline',
        marginBottom: spacing.sm,
    },
    scoreText: {
        fontSize: 64,
        fontWeight: 'bold',
        color: colors.primary,
        fontFamily: typography.fontFamily,
    },
    scoreMax: {
        fontSize: 24,
        color: colors['on-surface-variant'],
        fontWeight: '500',
        marginLeft: 4,
    },
    scoreDesc: {
        lineHeight: 24,
    },
    rowCards: {
        flexDirection: 'row',
        gap: spacing.md,
        marginBottom: spacing.lg,
    },
    halfCard: {
        flex: 1,
        backgroundColor: colors['surface-container-lowest'],
        borderWidth: 1,
        borderColor: colors['surface-variant'],
    },
    halfCardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginBottom: spacing.sm,
    },
    halfCardValue: {
        color: colors['on-surface'],
    },
    aiCard: {
        backgroundColor: colors['primary-fixed'],
        marginBottom: spacing.xl,
        borderWidth: 1,
        borderColor: colors['primary-fixed-dim'],
    },
    aiHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginBottom: spacing.md,
    },
    aiTitle: {
        color: colors['on-primary-container'],
    },
    recItem: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: spacing.sm,
        gap: spacing.sm,
    },
    recBullet: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: colors['on-primary-container'],
        marginTop: 8,
    },
    quickActions: {
        marginBottom: spacing.xxl,
    },
    sectionTitle: {
        marginBottom: spacing.md,
        color: colors['on-surface'],
    },
    actionGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-around',
        gap: spacing.md,
    },
    actionBtn: {
        alignItems: 'center',
        gap: spacing.sm,
    },
    actionIconWrapper: {
        width: 64,
        height: 64,
        borderRadius: shapes.roundedLg,
        backgroundColor: colors['surface-container-low'],
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: colors['surface-variant'],
    },
    floatingSosContainer: {
        position: 'absolute',
        bottom: spacing.lg,
        right: spacing.lg,
        ...Platform.select({
            ios: {
                shadowColor: colors.error,
                shadowOffset: { width: 0, height: 8 },
                shadowOpacity: 0.3,
                shadowRadius: 16,
            },
            android: {
                elevation: 8,
            },
        }),
    },
    floatingSos: {
        backgroundColor: colors.error,
    }
});
