import React, { useState, useRef, useEffect } from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity, Image, Switch, Modal, Animated, ActivityIndicator, Alert } from 'react-native';
import { Screen } from '../../components/Screen';
import { Text } from '../../components/Text';
import { colors, spacing, shapes, typography } from '../../theme/theme';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { journeyService } from '../../services/journeys';
import { sosService } from '../../services/sos';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSidebar } from '../../context/SidebarContext';
import { triggerSos, cancelSos, sendSafeFollowUp, resendSms } from '../../services/sosDispatcher';
import { useOutbox } from '../../context/OutboxContext';
import { SosStatusCard } from '../../components/SosStatusCard';
import { Toast } from '../../components/Toast';
import { NearestHelpStrip } from '../../components/NearestHelpStrip';
import { ensureWatching, getBestPosition } from '../../utils/locationWatcher';
import { shareLocation } from '../../utils/shareLocation';

export const SOSScreen = () => {
    const navigation = useNavigation();
    const route = useRoute();
    const { toggleDrawer } = useSidebar();
    const [activeJourney, setActiveJourney] = useState(null);
    const [showShareSheet, setShowShareSheet] = useState(false);

    // Toast States
    const [toastMessage, setToastMessage] = useState(null);
    const [toastType, setToastType] = useState('error');

    // SOS States
    const [activeSosRecord, setActiveSosRecord] = useState(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [userLocation, setUserLocation] = useState(null);
    const [statusMessage, setStatusMessage] = useState('SOS Status: Ready');
    const [sosError, setSosError] = useState(null);

    const { sos } = useOutbox();
    // The newest SOS that is not cancelled: pending, or delivered within the last 30 minutes.
    const latest = sos.find((s) => !(s.row.payload && s.row.payload.cancelled) && (s.row.status !== 'sent' || Date.now() - s.row.createdAt < 30 * 60 * 1000)) || null;
    const hasSos = Boolean(activeSosRecord || latest);
    const pulseAnim = useRef(new Animated.Value(1)).current;

    useEffect(() => {
        Animated.loop(
            Animated.sequence([
                Animated.timing(pulseAnim, {
                    toValue: 1.1,
                    duration: 1500,
                    useNativeDriver: true,
                }),
                Animated.timing(pulseAnim, {
                    toValue: 1,
                    duration: 1500,
                    useNativeDriver: true,
                })
            ])
        ).start();

        fetchCurrentLocation();
        ensureWatching();
        loadActiveSOS();
        loadJourney();

    }, []);

    // A navigation SOS request is sent immediately, so Home does not require a second tap. The id is new on every
    // press: this screen stays mounted between visits, so a plain flag would only ever fire the first time.
    const handledTrigger = useRef(null);
    useEffect(() => {
        const id = route.params?.triggerRequestId;
        if (id && handledTrigger.current !== id) {
            handledTrigger.current = id;
            handleSOSPress();
        }
    }, [route.params?.triggerRequestId]);

    // Restores the cancel controls after an app restart.
    const loadActiveSOS = async () => {
        setSosError(null);
        const res = await sosService.getActive();
        if (!res.success) {
            setSosError(
                res.error?.status === 0
                    ? 'You are offline. SOS status will refresh when the connection returns.'
                    : res.error?.message || 'Could not load the current SOS status.'
            );
            return;
        }
        if (res.data) {
            setActiveSosRecord(res.data);
            setStatusMessage('SOS ACTIVE: Emergency Contacts Notified');
        }
    };

    // Shadow Mode is the server-side journey ETA watch: it is ON exactly while a journey is active.
    const loadJourney = async () => {
        const res = await journeyService.getActive();
        setActiveJourney(res.success ? res.journey : null);
    };

    const fetchCurrentLocation = async () => {
        try {
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status === 'granted') {
                const loc = await getBestPosition();
                if (loc) {
                    setUserLocation({
                        latitude: loc.coords.latitude,
                        longitude: loc.coords.longitude,
                    });
                }
            }
        } catch (err) {
            console.warn('Could not fetch location for SOS:', err);
        }
    };

    // A fresh high-accuracy fix; falls back to the last known position, then to the screen's last fix.
    // The location is sent INSIDE the SOS request: /location does not have to be called first.
    const getSOSLocation = async () => {
        try {
            let perm = await Location.getForegroundPermissionsAsync();
            if (perm.status !== 'granted') perm = await Location.requestForegroundPermissionsAsync();
            if (perm.status === 'granted') {
                try {
                    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
                    return toSOSLocation(loc);
                } catch (e) {
                    const last = await Location.getLastKnownPositionAsync();
                    if (last) return toSOSLocation(last);
                }
            }
        } catch (e) {
            console.warn('Could not read location for SOS:', e);
        }
        return userLocation ? { ...userLocation, timestamp: new Date().toISOString() } : null;
    };

    const toSOSLocation = (loc) => {
        const coords = {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            accuracy: loc.coords.accuracy ?? undefined,
            timestamp: new Date(loc.timestamp).toISOString(),
        };
        setUserLocation({ latitude: coords.latitude, longitude: coords.longitude });
        return coords;
    };

    // The SOS is written to the outbox first, then sent / texted (services/sosDispatcher.js). The screen does not wait
    // for all of that: the status card below follows the real state (queued / SMS sent / delivered to server).
    const handleSOSPress = async () => {
        if (isSubmitting) return;
        setIsSubmitting(true);
        setSosError(null);
        triggerSos({
            source: 'manual',
            reason: 'Manual SOS button pressed by user.',
            journeyId: activeJourney?._id,
            location: userLocation || undefined, // no timestamp: this fix's age is unknown, and it must not read as "now"
        }).catch((err) => {
            setSosError(err.message || 'Could not start the SOS. Call your local emergency number.');
        });
        // the row shows up in the outbox within a moment; keep the button locked just long enough to avoid a double tap
        setTimeout(() => setIsSubmitting(false), 1500);
    };

    const confirmFollowUp = (result) => {
        if (!result.offerSafeSms) return;
        Alert.alert(
            "Send an \"I'm safe\" text?",
            `Your contacts may already have the SOS text (${result.textedPhones.length}). Send them a short message that you are safe?`,
            [
                { text: 'No', style: 'cancel' },
                {
                    text: "Send \"I'm safe\"",
                    onPress: async () => {
                        const state = await sendSafeFollowUp({ phones: result.textedPhones, triggeredAt: result.triggeredAt });
                        setToastType(state.outcome === 'sent' ? 'success' : 'error');
                        setToastMessage(
                            state.outcome === 'sent' ? "\"I'm safe\" text sent."
                            : state.outcome === 'composer_opened' ? 'Message opened: tap Send to tell your contacts you are safe.'
                            : "Could not send the \"I'm safe\" text."
                        );
                    },
                },
            ]
        );
    };

    const handleCancelSOS = async () => {
        // A queued / delivered SOS of this phone: removed from the queue if unsent, cancelled on the server otherwise.
        if (latest) {
            Alert.alert('Cancel this SOS?', latest.row.status === 'sent' ? 'It was delivered. It will be cancelled on the server.' : 'It has not reached the server yet, so it will simply be removed.', [
                { text: 'No', style: 'cancel' },
                {
                    text: 'Cancel SOS',
                    style: 'destructive',
                    onPress: async () => {
                        setIsSubmitting(true);
                        const result = await cancelSos({ key: latest.row.idempotencyKey, id: latest.row.id, volatile: !latest.row.id });
                        setIsSubmitting(false);
                        setActiveSosRecord(null);
                        setStatusMessage('SOS Status: Ready');
                        Alert.alert('Cancelled', result.action === 'remove' ? 'The SOS was removed before it reached the server.' : 'The SOS is being cancelled on the server.');
                        confirmFollowUp(result);
                    },
                },
            ]);
            return;
        }

        const sosId = activeSosRecord?._id || activeSosRecord?.id;
        if (!sosId) {
            setActiveSosRecord(null);
            setStatusMessage('SOS Status: Ready');
            return;
        }

        Alert.alert(
            'Cancel Emergency Action',
            'Are you sure you want to cancel the active SOS alert?',
            [
                { text: 'No', style: 'cancel' },
                {
                    text: 'Cancel SOS',
                    style: 'destructive',
                    onPress: async () => {
                        setIsSubmitting(true);
                        const res = await sosService.cancel(sosId, { reason: 'User cancelled emergency alert from app' });
                        setIsSubmitting(false);
                        if (res.success) {
                            setActiveSosRecord(null);
                            setStatusMessage('SOS Status: Ready');
                            Alert.alert('Cancelled', 'Emergency SOS alert has been cancelled.');
                        } else {
                            const message = res.error?.message || 'Could not cancel SOS.';
                            setSosError(res.error?.status === 0 ? 'You are offline. Reconnect and retry cancelling SOS.' : message);
                            Alert.alert('Error', message);
                        }
                    }
                }
            ]
        );
    };

    const latStr = userLocation ? `${userLocation.latitude.toFixed(4)}° N` : 'Location unavailable';
    const lngStr = userLocation ? `${userLocation.longitude.toFixed(4)}° E` : '';

    return (
        <Screen style={styles.container}>
            <Toast
                message={toastMessage}
                type={toastType}
                onDismiss={() => setToastMessage(null)}
            />
            {/* Top Navigation */}
            <View style={styles.header}>
                <View style={styles.headerLeft}>
                    <TouchableOpacity onPress={toggleDrawer} accessibilityLabel="Open menu">
                        <Ionicons name="menu" size={28} color={colors.primary} />
                    </TouchableOpacity>
                    <Ionicons name="shield-checkmark" size={24} color={colors.primary} />
                    <Text variant="headlineMd" style={styles.headerTitle}>SafeTours</Text>
                </View>
                <TouchableOpacity onPress={() => navigation.navigate('SOSHistory')}>
                    <Ionicons name="time" size={24} color={colors.primary} />
                </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                {sosError && (
                    <View style={styles.errorBanner}>
                        <Ionicons name="cloud-offline-outline" size={20} color={colors.error} />
                        <Text variant="labelMd" style={{ color: colors.error, flex: 1 }}>{sosError}</Text>
                        <TouchableOpacity onPress={loadActiveSOS}>
                            <Text variant="labelMd" style={{ color: colors.primary, fontWeight: 'bold' }}>Retry</Text>
                        </TouchableOpacity>
                    </View>
                )}
                
                {/* Emergency Header */}
                <View style={[styles.emergencyHeader, hasSos && { backgroundColor: colors.error }]}>
                    <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                        <Ionicons name="warning" size={32} color={hasSos ? colors.white : colors.error} />
                    </Animated.View>
                    <View style={styles.emergencyHeaderText}>
                        <Text variant="headlineSm" style={[{ fontWeight: 'bold' }, hasSos && { color: colors.white }]}>
                            {latest ? latest.view.headline : statusMessage}
                        </Text>
                        <Text variant="labelMd" style={[{ opacity: 0.8, textTransform: 'uppercase' }, hasSos && { color: colors.white }]}>
                            {hasSos ? "Emergency in progress" : "Tap to send an SOS"}
                        </Text>
                    </View>
                </View>

                {/* The honest status of each SOS: queued on the phone / SMS sent / delivered to the server */}
                {sos.slice(0, 2).filter((x) => !(x.row.payload && x.row.payload.cancelled)).map(({ row, view }) => (
                    <SosStatusCard
                        key={row.idempotencyKey}
                        row={row}
                        view={view}
                        busy={isSubmitting}
                        onCancel={latest && row === latest.row ? handleCancelSOS : undefined}
                        onResend={() => resendSms({ key: row.idempotencyKey, id: row.id, volatile: !row.id })}
                    />
                ))}

                {/* Big SOS Button */}
                <View style={styles.sosButtonContainer}>
                    <TouchableOpacity 
                        style={[styles.sosButton, hasSos && { backgroundColor: colors['error-container'] }]}
                        onPress={handleSOSPress}
                        activeOpacity={0.8}
                        disabled={isSubmitting}
                    >
                        {isSubmitting ? (
                            <ActivityIndicator size="large" color={colors.white} />
                        ) : (
                            <>
                                <Ionicons name="warning" size={48} color={hasSos ? colors.error : colors['on-error']} />
                                <Text variant="headlineSm" style={[styles.sosButtonText, hasSos && { color: colors.error }]}>
                                    {!hasSos ? "Send SOS" : latest && latest.row.status !== 'sent' ? "SOS SAVED" : "SOS ACTIVE"}
                                </Text>
                            </>
                        )}
                    </TouchableOpacity>
                    <Text variant="labelMd" style={styles.sosButtonHint}>
                        Saved on this phone first. Your contacts are texted and the SOS is uploaded as soon as there is a connection.
                    </Text>
                </View>

                {/* Live Location Card */}
                <View style={styles.cardContainer}>
                    <View style={styles.cardHeaderRow}>
                        <View style={styles.cardHeaderTitle}>
                            <Ionicons name="location" size={18} color={colors.primary} />
                            <Text variant="labelLg" style={styles.cardTitleText}>Live Location</Text>
                        </View>
                        <View style={styles.statusBadgeActive}>
                            <Text variant="labelMd" style={styles.statusBadgeText}>Active</Text>
                        </View>
                    </View>

                    <View style={styles.innerCard}>
                        <View style={styles.innerCardRowBorder}>
                            <Text variant="labelMd" color={colors['on-surface-variant']}>Coordinates</Text>
                            <Text variant="bodyMd" style={styles.monoText}>{latStr}, {lngStr}</Text>
                        </View>
                        <View style={styles.innerCardRow}>
                            <Text variant="labelMd" color={colors['on-surface-variant']}>Status</Text>
                            <Text variant="bodyMd" style={{ fontWeight: 'bold' }}>
                                {hasSos ? 'EMERGENCY_BROADCAST' : 'READY'}
                            </Text>
                        </View>
                    </View>

                    <TouchableOpacity style={styles.shareBtn} onPress={() => setShowShareSheet(true)}>
                        <Ionicons name="share-social" size={18} color={colors.tertiary} />
                        <Text variant="labelLg" style={styles.shareBtnText}>Share Status</Text>
                    </TouchableOpacity>
                </View>

                <NearestHelpStrip />

                {/* Shadow Mode Card */}
                <View style={styles.cardContainer}>
                    <View style={styles.cardHeaderRow}>
                        <View style={styles.cardHeaderTitle}>
                            <Ionicons name="eye-off" size={18} color={colors.primary} />
                            <Text variant="labelLg" style={styles.cardTitleText}>Shadow Mode</Text>
                        </View>
                        <Text variant="labelLg" style={{ color: activeJourney ? colors.tertiary : colors['on-surface-variant'], fontWeight: 'bold' }}>
                            {activeJourney ? 'ON' : 'OFF'}
                        </Text>
                    </View>

                    <Text variant="bodyMd" color={colors['on-surface-variant']} style={{ marginBottom: spacing.md }}>
                        {activeJourney
                            ? `Your journey is monitored by the server. If you have not arrived by ${new Date(activeJourney.expectedArrivalTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, you will be asked "Are you okay?" and your contacts are alerted if you do not answer.`
                            : 'Start a journey with an expected arrival time to turn Shadow Mode on. The server then checks on you if you do not arrive.'}
                    </Text>
                    <TouchableOpacity onPress={() => navigation.navigate('LiveJourney')} style={{ marginBottom: spacing.lg }}>
                        <Text variant="labelLg" color={colors.primary} style={{ fontWeight: 'bold' }}>
                            {activeJourney ? 'View journey' : 'Start a journey'}
                        </Text>
                    </TouchableOpacity>
                </View>

                {/* Cancel Area */}
                {hasSos && (
                    <View style={styles.cancelArea}>
                        <TouchableOpacity style={styles.cancelBtn} onPress={handleCancelSOS} disabled={isSubmitting}>
                            <Text variant="labelLg" color={colors.error} style={{ fontWeight: 'bold' }}>
                                CANCEL EMERGENCY ACTION
                            </Text>
                        </TouchableOpacity>
                    </View>
                )}
                
                <View style={{ height: 100 }} />
            </ScrollView>

            {/* Share Sheet */}
            <Modal visible={showShareSheet} transparent animationType="slide" onRequestClose={() => setShowShareSheet(false)}>
                <View style={styles.sheetOverlay}>
                    <View style={styles.sheetContent}>
                        <View style={styles.sheetHandle} />
                        <Text variant="headlineSm" style={{ fontWeight: 'bold', marginBottom: 4 }}>Share Live Location</Text>
                        <Text variant="bodyMd" color={colors['on-surface-variant']} style={{ marginBottom: 24 }}>
                            Choose who receives your location in the next step.
                        </Text>

                        <View style={styles.innerCard}>
                            <View style={styles.innerCardRow}>
                                <Text variant="labelMd" color={colors['on-surface-variant']} style={{ textTransform: 'uppercase' }}>Coordinates</Text>
                                <Text variant="bodyMd" style={styles.monoText}>{latStr}, {lngStr}</Text>
                            </View>
                            <View style={[styles.innerCardRow, { marginTop: 12 }]}>
                                <Text variant="labelMd" color={colors['on-surface-variant']} style={{ textTransform: 'uppercase' }}>Timestamp</Text>
                                <Text variant="bodyMd">{new Date().toLocaleTimeString()}</Text>
                            </View>
                        </View>

                        <TouchableOpacity
                            style={styles.shareNowBtn}
                            onPress={() => {
                                setShowShareSheet(false);
                                shareLocation(userLocation, { prefix: hasSos ? 'SOS: I need help. My location' : 'My current location' });
                            }}
                        >
                            <Text variant="headlineSm" color={colors.white} style={{ fontWeight: 'bold' }}>SHARE NOW</Text>
                        </TouchableOpacity>
                        
                        <TouchableOpacity style={styles.sheetCancelBtn} onPress={() => setShowShareSheet(false)}>
                            <Text variant="labelLg" color={colors['on-surface-variant']} style={{ fontWeight: 'bold' }}>CANCEL</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>
        </Screen>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
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
    scrollContent: {
        padding: spacing.lg,
    },
    errorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        backgroundColor: colors['error-container'] || '#ffdad6',
        padding: spacing.md,
        borderRadius: shapes.roundedMd,
        marginBottom: spacing.md,
    },
    emergencyHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        backgroundColor: colors['error-container'],
        padding: spacing.md,
        borderRadius: shapes.roundedMd,
        borderLeftWidth: 4,
        borderLeftColor: colors.error,
        marginBottom: spacing.lg,
    },
    emergencyHeaderText: {
        flex: 1,
    },
    sosButtonContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.md,
        marginBottom: spacing.xl,
    },
    sosButton: {
        width: 168,
        height: 168,
        borderRadius: 84,
        backgroundColor: colors.error,
        alignItems: 'center',
        justifyContent: 'center',
        elevation: 10,
        shadowColor: colors.error,
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.5,
        shadowRadius: 20,
        marginBottom: spacing.md,
    },
    sosButtonText: {
        color: colors.white,
        fontWeight: '900',
        textTransform: 'uppercase',
        marginTop: 8,
    },
    sosButtonHint: {
        color: colors['on-surface-variant'],
        textAlign: 'center',
        maxWidth: 200,
    },
    cardContainer: {
        backgroundColor: colors['surface-container-low'],
        borderRadius: shapes.roundedLg,
        padding: spacing.md,
        borderWidth: 1,
        borderColor: 'rgba(217, 194, 183, 0.3)',
        marginBottom: spacing.lg,
    },
    cardHeaderRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: spacing.md,
    },
    cardHeaderTitle: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    cardTitleText: {
        fontWeight: 'bold',
        color: colors.primary,
    },
    statusBadgeActive: {
        backgroundColor: colors['tertiary-container'],
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderRadius: shapes.roundedPill,
    },
    statusBadgeText: {
        color: colors['on-tertiary-container'],
    },
    innerCard: {
        backgroundColor: colors.white,
        borderRadius: shapes.roundedMd,
        padding: spacing.md,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
        elevation: 1,
    },
    innerCardRowBorder: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(217, 194, 183, 0.2)',
        paddingBottom: spacing.sm,
        marginBottom: spacing.sm,
    },
    innerCardRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    monoText: {
        fontFamily: 'monospace',
    },
    shareBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 12,
        marginTop: spacing.md,
        borderWidth: 2,
        borderColor: colors.tertiary,
        borderRadius: shapes.roundedMd,
    },
    shareBtnText: {
        color: colors.tertiary,
    },
    cancelArea: {
        paddingTop: spacing.md,
    },
    cancelBtn: {
        width: '100%',
        paddingVertical: 16,
        borderWidth: 2,
        borderColor: colors.error,
        borderRadius: shapes.roundedPill,
        alignItems: 'center',
        justifyContent: 'center',
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing.xl,
    },
    modalContent: {
        width: '100%',
        maxWidth: 400,
        backgroundColor: 'rgba(255, 255, 255, 0.95)',
        borderRadius: 32,
        padding: spacing.xl,
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 20 },
        shadowOpacity: 0.3,
        shadowRadius: 30,
        elevation: 10,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.4)',
    },
    timerCircle: {
        width: 128,
        height: 128,
        borderRadius: 64,
        borderWidth: 8,
        borderColor: colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: spacing.lg,
    },
    timerText: {
        fontSize: 48,
        fontWeight: 'bold',
        color: colors.primary,
    },
    safeBtn: {
        width: '100%',
        paddingVertical: 16,
        backgroundColor: colors.tertiary,
        borderRadius: shapes.roundedPill,
        alignItems: 'center',
        marginBottom: spacing.md,
    },
    emergencyModalBtn: {
        width: '100%',
        paddingVertical: 16,
        backgroundColor: colors.error,
        borderRadius: shapes.roundedPill,
        alignItems: 'center',
    },
    sheetOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
        justifyContent: 'flex-end',
    },
    sheetContent: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: 32,
        borderTopRightRadius: 32,
        padding: spacing.xl,
        paddingBottom: spacing.xxl,
    },
    sheetHandle: {
        width: 48,
        height: 6,
        backgroundColor: 'rgba(217, 194, 183, 0.5)',
        borderRadius: 3,
        alignSelf: 'center',
        marginBottom: spacing.md,
    },
    shareNowBtn: {
        width: '100%',
        paddingVertical: 16,
        backgroundColor: colors.tertiary,
        borderRadius: shapes.roundedPill,
        alignItems: 'center',
        marginTop: spacing.xl,
        marginBottom: spacing.md,
    },
    sheetCancelBtn: {
        width: '100%',
        paddingVertical: 16,
        borderWidth: 2,
        borderColor: colors['outline-variant'],
        borderRadius: shapes.roundedPill,
        alignItems: 'center',
    }
});
