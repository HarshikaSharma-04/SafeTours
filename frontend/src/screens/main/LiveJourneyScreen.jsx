import React, { useState, useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet, TouchableOpacity, ScrollView, Dimensions, ActivityIndicator, Alert, TextInput, Modal } from 'react-native';
import { Screen } from '../../components/Screen';
import { Text } from '../../components/Text';
import { colors, spacing, shapes, typography } from '../../theme/theme';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import * as Location from 'expo-location';
import { journeyService } from '../../services/journeys';
import { placesService } from '../../services/places';
import { locationService } from '../../services/locationService';
import { sosService } from '../../services/sos';
import { MapComponent, getRiskColors } from '../../components/MapComponent';
import { riskService } from '../../services/riskService';
import { isDangerLevel } from '../../utils/riskLevels';
import { startBackgroundGeofence, stopBackgroundGeofence } from '../../utils/backgroundGeofence';
import { geofenceManager, calculateDistanceMeters } from '../../utils/geofenceManager';
import { ensureWatching, getBestPosition } from '../../utils/locationWatcher';
import { locationBus } from '../../utils/locationBus';
import { formatDistance } from '../../utils/geo';
import { useConnectivity } from '../../context/ConnectivityContext';
import { useOfflineData } from '../../context/OfflineDataContext';

import { triggerSos } from '../../services/sosDispatcher';
import { Toast } from '../../components/Toast';

const { width, height } = Dimensions.get('window');

// Added on top of the routing estimate, so the safety timer does not fire at a normal pace with one stop at a light.
const ETA_MARGIN = 1.25;
const JOURNEY_POLL_MS = 20000;
const LOCATION_SYNC_DISTANCE_M = 30;
const MAP_BOTTOM_INSET = 300;

const formatDuration = (seconds) => {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

const routeRiskText = (route) => {
    const risk = route?.risk;
    if (!risk || !risk.cellsChecked) return null;
    const danger = (risk.counts?.HIGH || 0) + (risk.counts?.EXTREME || 0);
    const covered = risk.cellsChecked - risk.unknownCells;
    if (covered === 0) return 'No risk data along this route, so its safety is unknown.';
    const worst = getRiskColors(risk.worstLevel).label;
    const unknown = risk.unknownCells ? ` ${risk.unknownCells} of ${risk.cellsChecked} areas have no data.` : '';
    return danger > 0
        ? `Passes through ${danger} high-risk area${danger === 1 ? '' : 's'} (worst: ${worst}).${unknown}`
        : `Highest level along this route: ${worst}.${unknown}`;
};

export const LiveJourneyScreen = () => {
    const navigation = useNavigation();
    const route = useRoute();

    const [bottomSheetExpanded, setBottomSheetExpanded] = useState(true);

    // Toast States
    const [toastMessage, setToastMessage] = useState(null);
    const [toastType, setToastType] = useState('error');
    
    // Journey state
    const [activeJourney, setActiveJourney] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [modalError, setModalError] = useState(null);
    const [errorMessage, setErrorMessage] = useState(null);
    const [dangerZones, setDangerZones] = useState([]);
    const [journeyWarning, setJourneyWarning] = useState(null);

    // Form inputs for starting a new journey
    const [showStartModal, setShowStartModal] = useState(false);
    const [destination, setDestination] = useState(null); // { latitude, longitude, name, address }
    const [destQuery, setDestQuery] = useState('');
    const [destSuggestions, setDestSuggestions] = useState([]);
    const [isSearchingDest, setIsSearchingDest] = useState(false);
    const [travelMode, setTravelMode] = useState('foot');
    const [plannedRoute, setPlannedRoute] = useState(null);
    const [isRouteLoading, setIsRouteLoading] = useState(false);
    const destTimerRef = useRef(null);
    const destSeq = useRef(0);
    const timerEdited = useRef(false); // the user's own timer is never overwritten by a route estimate
    const [etaHours, setEtaHours] = useState('');
    const [etaMinutes, setEtaMinutes] = useState('');
    const [etaSeconds, setEtaSeconds] = useState('');

    // Live GPS location
    const [userLocation, setUserLocation] = useState(null);
    const sosKeyRef = useRef(sosService.newKey()); // reused on retries: one tap can never make two SOS

    useEffect(() => {
        loadInitialState();
        return () => {
            if (destTimerRef.current) clearTimeout(destTimerRef.current);
        };
    }, []);

    // "Route Here" on the map opens this screen with the place already chosen.
    useEffect(() => {
        const dest = route.params?.destination;
        if (!dest) return;
        setDestination(dest);
        setDestQuery(dest.name || '');
        setDestSuggestions([]);
        setShowStartModal(true);
    }, [route.params?.requestId]); // eslint-disable-line react-hooks/exhaustive-deps

    // The route for the journey being planned or followed.
    const routeTarget = useMemo(() => {
        const coords = activeJourney?.destination?.coordinates;
        if (Array.isArray(coords)) return { latitude: Number(coords[1]), longitude: Number(coords[0]) };
        return destination ? { latitude: destination.latitude, longitude: destination.longitude } : null;
    }, [activeJourney?._id, destination?.latitude, destination?.longitude]); // eslint-disable-line react-hooks/exhaustive-deps

    // Planned from where the user is now; a journey in progress keeps the route from where it started.
    const routeOrigin = useMemo(() => {
        const start = activeJourney?.startLocation?.coordinates;
        if (Array.isArray(start)) return { latitude: Number(start[1]), longitude: Number(start[0]) };
        return userLocation;
    }, [activeJourney?._id, Boolean(userLocation)]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!routeTarget || !routeOrigin) {
            setPlannedRoute(null);
            return undefined;
        }
        let stale = false;
        setIsRouteLoading(true);
        placesService.getRoute(routeOrigin, routeTarget, travelMode).then((res) => {
            if (stale) return;
            setIsRouteLoading(false);
            setPlannedRoute(res.success ? res.data : null);
            if (res.success && res.data?.durationSeconds && !timerEdited.current && !activeJourney) {
                const total = Math.ceil((res.data.durationSeconds * ETA_MARGIN) / 60);
                setEtaHours(total >= 60 ? String(Math.floor(total / 60)) : '');
                setEtaMinutes(String(total % 60));
                setEtaSeconds('');
            }
        });
        return () => {
            stale = true;
        };
    }, [routeTarget, routeOrigin, travelMode]); // eslint-disable-line react-hooks/exhaustive-deps

    const mapRoute = useMemo(() => (plannedRoute?.path?.length >= 2
        ? {
            points: plannedRoute.path.map(([latitude, longitude]) => ({ latitude, longitude })),
            dashed: plannedRoute.source === 'straight-line',
        }
        : null), [plannedRoute]);

    // Follow the GPS while this screen is open. Each stored point also runs the server's arrival check, so this works
    // in Expo Go too, where background tracking is not available.
    const lastSynced = useRef(null);
    const journeyActiveRef = useRef(false);
    journeyActiveRef.current = Boolean(activeJourney);
    useEffect(() => {
        ensureWatching();
        return locationBus.subscribe((fix) => {
            setUserLocation({ latitude: fix.latitude, longitude: fix.longitude });
            if (!journeyActiveRef.current) return;
            const moved = lastSynced.current
                ? calculateDistanceMeters(lastSynced.current.latitude, lastSynced.current.longitude, fix.latitude, fix.longitude)
                : Infinity;
            if (moved > LOCATION_SYNC_DISTANCE_M) {
                lastSynced.current = { latitude: fix.latitude, longitude: fix.longitude };
                locationService.syncLocation({ latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy, timestamp: new Date(fix.timestamp).toISOString() });
            }
        });
    }, []);

    // The server can end a journey on its own (arrival detected): keep this screen in step with it.
    useEffect(() => {
        if (!activeJourney?._id) return undefined;
        const timer = setInterval(async () => {
            const res = await journeyService.getActive();
            if (res.success && !res.journey) {
                setActiveJourney(null);
                setPlannedRoute(null);
                setToastType('success');
                setToastMessage('Your journey has ended.');
            }
        }, JOURNEY_POLL_MS);
        return () => clearInterval(timer);
    }, [activeJourney?._id]);

    const handleDestQueryChange = (text) => {
        setDestQuery(text);
        setDestination(null);
        if (destTimerRef.current) clearTimeout(destTimerRef.current);
        const seq = ++destSeq.current;
        if (text.trim().length < 2) {
            setDestSuggestions([]);
            setIsSearchingDest(false);
            return;
        }
        setIsSearchingDest(true);
        destTimerRef.current = setTimeout(async () => {
            const res = await placesService.search(text, userLocation);
            if (seq !== destSeq.current) return;
            setIsSearchingDest(false);
            setDestSuggestions(res.data || []);
        }, 500);
    };

    const handlePickDestination = (place) => {
        destSeq.current += 1;
        setDestination(place);
        setDestQuery(place.name);
        setDestSuggestions([]);
        setIsSearchingDest(false);
        timerEdited.current = false;
    };

    const editTimer = (setter) => (value) => {
        timerEdited.current = true;
        setter(value);
    };

    // Save the destination's risk cells and nearby places on the phone while we still have a connection, so the
    // journey can finish with the on-device check if the signal drops. Once per journey, only when ONLINE.
    const conn = useConnectivity();
    const offlineData = useOfflineData();
    const preparedFor = useRef(null);
    useEffect(() => {
        const dest = activeJourney?.destination?.coordinates; // GeoJSON [lng, lat]
        if (!activeJourney?._id || !Array.isArray(dest) || conn.state !== 'ONLINE' || preparedFor.current === activeJourney._id) return;
        preparedFor.current = activeJourney._id;
        offlineData?.prepareDestination(Number(dest[1]), Number(dest[0]), activeJourney._id);
    }, [activeJourney?._id, conn.state]); // eslint-disable-line react-hooks/exhaustive-deps

    // Shadow Mode is enforced by the SERVER: when the ETA passes it asks "Are you okay?" (the global
    // prompt in SafetyCheckProvider) and alerts your contacts if you do not answer. No client timers here.
    // Background tracking runs only while a journey is active (it also detects arrival).
    useEffect(() => {
        if (activeJourney) startBackgroundGeofence();
        else stopBackgroundGeofence();
    }, [activeJourney?._id]); // eslint-disable-line react-hooks/exhaustive-deps

    const loadInitialState = async () => {
        setIsLoading(true);
        setErrorMessage(null);
        try {
            // Get current location. A slow or missing GPS fix must not stop the journey status from loading.
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status === 'granted') {
                ensureWatching();
                const loc = await getBestPosition();
                if (loc) {
                    const currentLocation = {
                        latitude: loc.coords.latitude,
                        longitude: loc.coords.longitude,
                    };
                    setUserLocation(currentLocation);

                    // Risk cells around the traveller so the journey map shows nearby risks.
                    const zonesResult = await riskService.getCellsAround(
                        currentLocation.latitude,
                        currentLocation.longitude,
                        3000,
                        'SAFE'
                    );
                    if (zonesResult.success) {
                        setDangerZones(zonesResult.data || []);

                        // Journey warning comes from the backend geofence state (dwell + hysteresis applied).
                        const last = geofenceManager.lastResult;
                        if (last?.insideDangerZone) setJourneyWarning(last.message);
                    }
                }
            }

            // Check active journey status
            const res = await journeyService.getActive();
            if (res.success && res.journey) {
                setActiveJourney(res.journey);
            } else {
                setActiveJourney(null);
            }
        } catch (err) {
            console.error('Error loading live journey state:', err);
            setErrorMessage('Could not load journey status.');
        } finally {
            setIsLoading(false);
        }
    };

    const handleStartJourney = async () => {
        setIsSubmitting(true);
        setErrorMessage(null);

        const currentLat = userLocation?.latitude;
        const currentLng = userLocation?.longitude;

        const durationSeconds = (Number(etaHours || 0) * 3600)
            + (Number(etaMinutes || 0) * 60)
            + Number(etaSeconds || 0);

        if (!Number.isFinite(currentLat) || !Number.isFinite(currentLng)) {
            setIsSubmitting(false);
            setModalError('Your location is not available yet. Turn on GPS and try again.');
            return;
        }
        if (!destination) {
            setIsSubmitting(false);
            setModalError('Search for your destination and pick it from the list.');
            return;
        }
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
            setIsSubmitting(false);
            setModalError('Choose a journey safety timer greater than zero.');
            return;
        }

        const expectedArrivalTime = new Date(Date.now() + durationSeconds * 1000).toISOString();

        const payload = {
            startLocation: [currentLng, currentLat], // GeoJSON standard [lng, lat]
            destination: [destination.longitude, destination.latitude],
            expectedArrivalTime,
            ...(destination.name ? { destinationName: String(destination.name).slice(0, 200) } : {}),
        };

        const res = await journeyService.start(payload);
        setIsSubmitting(false);

        if (res.success && res.journey) {
            setActiveJourney(res.journey);
            setShowStartModal(false);
            setModalError(null);
            setEtaMinutes('');
            setEtaHours('');
            setEtaSeconds('');
            Alert.alert('Journey Started', res.message || 'Your journey is now being monitored.');
        } else {
            setModalError(res.error?.message || 'Failed to start journey.');
        }
    };

    const handleEndJourney = async (status = 'COMPLETED') => {
        if (!activeJourney?._id) return;
        
        Alert.alert(
            status === 'COMPLETED' ? 'End Journey' : 'Cancel Journey',
            `Are you sure you want to mark this journey as ${status.toLowerCase()}?`,
            [
                { text: 'No', style: 'cancel' },
                {
                    text: 'Yes',
                    style: status === 'COMPLETED' ? 'default' : 'destructive',
                    onPress: async () => {
                        setIsSubmitting(true);
                        const res = await journeyService.end(activeJourney._id, status);
                        setIsSubmitting(false);
                        if (res.success) {
                            setActiveJourney(null);
                            setDestination(null);
                            setDestQuery('');
                            setPlannedRoute(null);
                            setEtaMinutes('');
                            timerEdited.current = false;
                            Alert.alert('Journey Updated', res.message || 'Your journey status has been saved.');
                        } else {
                            Alert.alert('Error', res.error?.message || 'Failed to end journey.');
                        }
                    }
                }
            ]
        );
    };

    const handleUpdateJourney = async () => {
        if (!activeJourney?._id) return;

        const durationSeconds = (Number(etaHours || 0) * 3600)
            + (Number(etaMinutes || 0) * 60)
            + Number(etaSeconds || 0);
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
            setErrorMessage('Choose a journey safety timer greater than zero before updating the journey.');
            return;
        }

        setIsSubmitting(true);
        setErrorMessage(null);
        const res = await journeyService.update(activeJourney._id, {
            expectedArrivalTime: new Date(Date.now() + durationSeconds * 1000).toISOString(),
        });
        setIsSubmitting(false);

        if (res.success && res.journey) {
            setActiveJourney(res.journey);
            Alert.alert('Journey Updated', res.message || 'Your expected arrival time has been updated.');
        } else if (res.queued) {
            Alert.alert('Saved offline', res.message);
        } else {
            setErrorMessage(res.error?.message || 'Failed to update journey.');
        }
    };

    // Written to the outbox first, then sent / texted (services/sosDispatcher.js). The SOS screen shows the real state.
    const handleTriggerSOS = async () => {
        triggerSos({
            source: 'journey',
            reason: 'SOS triggered during an active journey.',
            journeyId: activeJourney?._id,
            location: Number.isFinite(userLocation?.latitude)
                ? { latitude: userLocation.latitude, longitude: userLocation.longitude, timestamp: new Date().toISOString() }
                : undefined,
        }).catch((err) => {
            Alert.alert('SOS problem', err.message || 'Could not start the SOS. Call your local emergency number.');
        });
        navigation.navigate('SOS');
    };

    // Calculate arrival time string
    const etaFormatted = activeJourney?.expectedArrivalTime
        ? new Date(activeJourney.expectedArrivalTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '—';

    const journeyTitle = activeJourney?.metadata?.destinationName
        || (activeJourney ? `${activeJourney.destination?.coordinates?.[1] ?? '—'}, ${activeJourney.destination?.coordinates?.[0] ?? '—'}` : null);

    // How much of the straight-line distance from the start is done. Real position only: no position, no number.
    const journeyProgress = useMemo(() => {
        const start = activeJourney?.startLocation?.coordinates;
        const end = activeJourney?.destination?.coordinates;
        if (!Array.isArray(start) || !Array.isArray(end) || !userLocation) return null;
        const total = calculateDistanceMeters(start[1], start[0], end[1], end[0]);
        if (!(total > 0)) return null;
        const left = calculateDistanceMeters(userLocation.latitude, userLocation.longitude, end[1], end[0]);
        return { percent: Math.round(Math.min(1, Math.max(0, 1 - left / total)) * 100), left };
    }, [activeJourney?._id, userLocation?.latitude, userLocation?.longitude]); // eslint-disable-line react-hooks/exhaustive-deps

    const mapDestination = routeTarget ? { ...routeTarget, name: journeyTitle || destination?.name } : null;
    const riskText = routeRiskText(plannedRoute);

    return (
        <Screen style={styles.container} isSafe={false}>
            <Toast
                message={toastMessage}
                type={toastType}
                onDismiss={() => setToastMessage(null)}
            />
            {/* Map View */}
            <MapComponent 
                region={userLocation ? {
                    latitude: userLocation.latitude,
                    longitude: userLocation.longitude,
                    latitudeDelta: 0.02,
                    longitudeDelta: 0.02,
                } : undefined}
                userLocation={userLocation}
                dangerZones={dangerZones}
                destinationMarker={mapDestination}
                route={mapRoute}
                bottomInset={MAP_BOTTOM_INSET}
            />

            {/* Top Navigation Header */}
            <View style={styles.topHeader}>
                <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
                    <Ionicons name="arrow-back" size={24} color={colors['on-surface']} />
                </TouchableOpacity>

                <View style={styles.destinationBox}>
                    <Text variant="labelMd" color={colors['on-surface-variant']} style={{ textTransform: 'uppercase' }}>
                        {activeJourney ? "Active Journey To" : "Destination"}
                    </Text>
                    <Text variant="headlineSm" style={{ fontWeight: 'bold' }} numberOfLines={1}>
                                {activeJourney ? journeyTitle : (destination?.name || "No Active Journey")}
                    </Text>
                </View>
                {activeJourney ? (
                    <TouchableOpacity style={styles.cancelBtn} onPress={() => handleEndJourney('CANCELLED')}>
                        <Text variant="labelLg" color={colors.error} style={{ fontWeight: 'bold' }}>Cancel</Text>
                    </TouchableOpacity>
                ) : (
                    <TouchableOpacity style={styles.startHeaderBtn} onPress={() => setShowStartModal(true)}>
                        <Text variant="labelLg" color={colors.primary} style={{ fontWeight: 'bold' }}>Start</Text>
                    </TouchableOpacity>
                )}
            </View>

            {/* Floating SOS Button */}
            <TouchableOpacity style={styles.sosFab} onPress={handleTriggerSOS}>
                <Ionicons name="warning" size={32} color={colors.white} />
            </TouchableOpacity>

            {/* Bottom Sheet */}
            <View style={[styles.bottomSheet, bottomSheetExpanded && styles.bottomSheetExpanded]}>
                <TouchableOpacity 
                    style={styles.sheetHandleContainer}
                    onPress={() => setBottomSheetExpanded(!bottomSheetExpanded)}
                >
                    <View style={styles.sheetHandle} />
                </TouchableOpacity>

                {errorMessage && (
                    <View style={styles.errorBox}>
                        <Ionicons name="alert-circle" size={20} color={colors.error} />
                        <Text variant="labelMd" style={{ color: colors.error, flex: 1 }}>{errorMessage}</Text>
                        <TouchableOpacity onPress={loadInitialState}>
                            <Text variant="labelMd" style={{ color: colors.primary, fontWeight: 'bold' }}>Retry</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {journeyWarning && activeJourney && (
                    <View style={styles.warningBox}>
                        <Ionicons name="shield-outline" size={20} color={colors.error} />
                        <Text variant="labelMd" style={{ color: colors.error, flex: 1 }}>{journeyWarning}</Text>
                    </View>
                )}

                {isLoading ? (
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator size="large" color={colors.primary} />
                        <Text variant="labelLg" color={colors['on-surface-variant']} style={{ marginTop: 8 }}>
                            Syncing journey status...
                        </Text>
                    </View>
                ) : activeJourney ? (
                    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: spacing.xxl }}>
                        {/* Progress Header */}
                        <View style={styles.progressHeader}>
                            <View>
                                <Text variant="headlineMd" style={{ fontWeight: 'bold' }}>Journey Active</Text>
                                <Text variant="bodyMd" color={colors['on-surface-variant']}>ETA: {etaFormatted}</Text>
                            </View>
                            <View style={styles.safeRouteBadge}>
                                <Ionicons name="shield-checkmark" size={20} color={colors.primary} />
                                <Text variant="labelLg" color={colors.primary} style={{ fontWeight: 'bold' }}>
                                    {activeJourney.status || 'ACTIVE'}
                                </Text>
                            </View>
                        </View>

                        {/* Progress Bar */}
                        <View style={styles.progressBarBg}>
                            <View style={[styles.progressBarFill, { width: `${journeyProgress?.percent ?? 0}%` }]} />
                        </View>
                        {journeyProgress && (
                            <Text variant="labelMd" color={colors['on-surface-variant']} style={{ marginBottom: spacing.sm }}>
                                {journeyProgress.percent}% of the way · {formatDistance(journeyProgress.left)} to go
                            </Text>
                        )}

                        {/* Stats Bento Grid */}
                        <View style={styles.statsGrid}>
                            <View style={styles.statBox}>
                                <Text variant="labelSm" color={colors.outline} style={styles.statLabel}>Status</Text>
                                <Text variant="headlineSm" style={{ fontWeight: 'bold', color: colors.primary }}>
                                    {activeJourney.status}
                                </Text>
                            </View>
                            <View style={styles.statBox}>
                                <Text variant="labelSm" color={colors.outline} style={styles.statLabel}>Target ETA</Text>
                                <Text variant="headlineSm" style={{ fontWeight: 'bold' }}>{etaFormatted}</Text>
                            </View>
                        </View>

                        {/* The existing journey endpoint supports ETA changes while ACTIVE. */}
                        <View style={styles.updateEtaRow}>
                            <TextInput
                                style={styles.etaInput}
                                value={etaMinutes}
                                onChangeText={editTimer(setEtaMinutes)}
                                keyboardType="numeric"
                                placeholder="Minutes"
                            />
                            <TouchableOpacity
                                style={styles.updateEtaButton}
                                onPress={handleUpdateJourney}
                                disabled={isSubmitting}
                            >
                                <Text variant="labelMd" color={colors.white} style={{ fontWeight: 'bold' }}>Update ETA</Text>
                            </TouchableOpacity>
                        </View>

                        {/* What the route actually passes through */}
                        <View style={styles.aiBox}>
                            <View style={styles.aiIconWrapper}>
                                <Ionicons name="shield-half-outline" size={24} color={colors.secondary} />
                            </View>
                            <View style={{ flex: 1 }}>
                                <Text variant="labelLg" style={{ fontWeight: 'bold', color: colors['on-secondary-container'] }}>Route safety</Text>
                                <Text variant="labelMd" style={{ color: colors['on-secondary-container'], opacity: 0.8, marginTop: 4 }}>
                                    {isRouteLoading ? 'Checking the route...' : riskText || 'Route risk is not available right now.'}
                                    {plannedRoute?.source === 'straight-line' ? ' Dotted line: straight-line estimate, not a road route.' : ''}
                                </Text>
                            </View>
                        </View>

                        {/* Action Buttons Row */}
                        <View style={styles.actionRow}>
                            <TouchableOpacity 
                                style={styles.completeBtn} 
                                onPress={() => handleEndJourney('COMPLETED')}
                                disabled={isSubmitting}
                            >
                                {isSubmitting ? (
                                    <ActivityIndicator size="small" color={colors.white} />
                                ) : (
                                    <>
                                        <Ionicons name="checkmark-circle" size={20} color={colors.white} />
                                        <Text variant="labelLg" color={colors.white} style={{ fontWeight: 'bold' }}>
                                            Complete Journey
                                        </Text>
                                    </>
                                )}
                            </TouchableOpacity>
                        </View>
                    </ScrollView>
                ) : (
                    <View style={styles.noJourneyContainer}>
                        <Ionicons name="navigate-circle-outline" size={64} color={colors.primary} />
                        <Text variant="headlineSm" style={{ fontWeight: 'bold', marginTop: 12 }}>No Active Journey</Text>
                        <Text variant="bodyMd" color={colors['on-surface-variant']} style={{ textAlign: 'center', marginVertical: 8 }}>
                            Start a journey to enable live tracking, ETA monitoring, and safety alerts.
                        </Text>

                        <TouchableOpacity 
                            style={styles.startNewBtn}
                            onPress={() => setShowStartModal(true)}
                        >
                            <Ionicons name="play" size={20} color={colors.white} />
                            <Text variant="labelLg" color={colors.white} style={{ fontWeight: 'bold' }}>
                                Start New Journey
                            </Text>
                        </TouchableOpacity>
                    </View>
                )}
            </View>

            {/* Start Journey Modal */}
            <Modal visible={showStartModal} transparent animationType="slide" onRequestClose={() => setShowStartModal(false)}>
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <View style={styles.modalHeader}>
                            <Text variant="headlineSm" style={{ fontWeight: 'bold' }}>Start New Journey</Text>
                            <TouchableOpacity onPress={() => setShowStartModal(false)}>
                                <Ionicons name="close" size={24} color={colors['on-surface-variant']} />
                            </TouchableOpacity>
                        </View>

                        {modalError && (
                            <View style={styles.errorBox}>
                                <Ionicons name="alert-circle" size={20} color={colors.error} />
                                <Text variant="labelMd" style={{ color: colors.error, flex: 1 }}>{modalError}</Text>
                            </View>
                        )}

                        <Text variant="labelLg" style={{ marginBottom: 4 }}>Destination</Text>
                        <TextInput
                            style={styles.input}
                            value={destQuery}
                            onChangeText={handleDestQueryChange}
                            placeholder="Search for a place"
                            autoCorrect={false}
                        />
                        {isSearchingDest && <ActivityIndicator size="small" color={colors.primary} style={{ marginBottom: spacing.sm }} />}
                        {destSuggestions.length > 0 && (
                            <ScrollView style={{ maxHeight: 160, marginBottom: spacing.sm }} keyboardShouldPersistTaps="handled">
                                {destSuggestions.map((place, index) => (
                                    <TouchableOpacity
                                        key={`${place.latitude}_${place.longitude}_${index}`}
                                        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 }}
                                        onPress={() => handlePickDestination(place)}
                                    >
                                        <Ionicons name="location-outline" size={18} color={colors.primary} />
                                        <View style={{ flex: 1 }}>
                                            <Text variant="labelLg" numberOfLines={1}>{place.name}</Text>
                                            {place.address ? <Text variant="labelSm" color={colors['on-surface-variant']} numberOfLines={1}>{place.address}</Text> : null}
                                        </View>
                                    </TouchableOpacity>
                                ))}
                            </ScrollView>
                        )}

                        {destination && (
                            <>
                                <View style={{ flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm }}>
                                    {[{ key: 'foot', label: 'Walk', icon: 'walk' }, { key: 'car', label: 'Drive', icon: 'car' }].map((m) => (
                                        <TouchableOpacity
                                            key={m.key}
                                            onPress={() => setTravelMode(m.key)}
                                            style={{
                                                flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
                                                backgroundColor: travelMode === m.key ? colors.primary : colors['surface-container-high'],
                                            }}
                                        >
                                            <Ionicons name={m.icon} size={16} color={travelMode === m.key ? colors.white : colors['on-surface']} />
                                            <Text variant="labelMd" style={{ color: travelMode === m.key ? colors.white : colors['on-surface'] }}>{m.label}</Text>
                                        </TouchableOpacity>
                                    ))}
                                </View>
                                {isRouteLoading ? (
                                    <ActivityIndicator size="small" color={colors.primary} style={{ marginBottom: spacing.sm }} />
                                ) : plannedRoute ? (
                                    <Text variant="labelMd" color={colors['on-surface-variant']} style={{ marginBottom: spacing.sm }}>
                                        {formatDistance(plannedRoute.distanceMeters)} · about {formatDuration(plannedRoute.durationSeconds)}
                                        {plannedRoute.source === 'straight-line' ? ' (straight-line estimate)' : ''}
                                        {riskText ? `\n${riskText}` : ''}
                                    </Text>
                                ) : null}
                            </>
                        )}

                        <Text variant="labelLg" style={{ marginBottom: 4 }}>Journey Safety Timer</Text>
                        <Text variant="labelSm" color={colors['on-surface-variant']} style={{ marginBottom: 6 }}>
                            If you have not arrived by then, SafeTours asks if you are okay, and alerts your contacts if you do not answer.
                        </Text>
                        <View style={styles.timerInputs}>
                            <TextInput style={[styles.input, styles.timerInput]} value={etaHours} onChangeText={editTimer(setEtaHours)} keyboardType="numeric" placeholder="Hours" />
                            <TextInput style={[styles.input, styles.timerInput]} value={etaMinutes} onChangeText={editTimer(setEtaMinutes)} keyboardType="numeric" placeholder="Minutes" />
                            <TextInput style={[styles.input, styles.timerInput]} value={etaSeconds} onChangeText={editTimer(setEtaSeconds)} keyboardType="numeric" placeholder="Seconds" />
                        </View>

                        <TouchableOpacity 
                            style={styles.modalSubmitBtn}
                            onPress={handleStartJourney}
                            disabled={isSubmitting}
                        >
                            {isSubmitting ? (
                                <ActivityIndicator size="small" color={colors.white} />
                            ) : (
                                <Text variant="labelLg" color={colors.white} style={{ fontWeight: 'bold' }}>
                                    Confirm & Start Journey
                                </Text>
                            )}
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
        backgroundColor: colors.background,
    },
    topHeader: {
        position: 'absolute',
        top: spacing.xl,
        left: spacing.md,
        right: spacing.md,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.95)',
        borderRadius: shapes.roundedLg,
        padding: spacing.md,
        zIndex: 10,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.1,
        shadowRadius: 10,
        elevation: 5,
    },
    backBtn: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: colors['surface-container-high'],
        alignItems: 'center',
        justifyContent: 'center',
    },
    destinationBox: {
        flex: 1,
        paddingHorizontal: spacing.md,
    },
    cancelBtn: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
    },
    startHeaderBtn: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
    },
    sosFab: {
        position: 'absolute',
        bottom: 260,
        right: spacing.md,
        width: 64,
        height: 64,
        borderRadius: 32,
        backgroundColor: colors.error,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: colors.error,
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.4,
        shadowRadius: 15,
        elevation: 8,
        zIndex: 20,
    },
    bottomSheet: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        maxHeight: 460,
        backgroundColor: colors['surface-container-lowest'],
        borderTopLeftRadius: 32,
        borderTopRightRadius: 32,
        paddingHorizontal: spacing.xl,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -10 },
        shadowOpacity: 0.1,
        shadowRadius: 20,
        elevation: 20,
        zIndex: 30,
    },
    bottomSheetExpanded: {},
    sheetHandleContainer: {
        alignItems: 'center',
        paddingVertical: spacing.md,
    },
    sheetHandle: {
        width: 48,
        height: 6,
        backgroundColor: colors['outline-variant'],
        borderRadius: 3,
    },
    loadingContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.xl,
    },
    errorBox: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        backgroundColor: colors['error-container'] || '#ffdad6',
        padding: spacing.md,
        borderRadius: shapes.roundedSm,
        marginBottom: spacing.md,
    },
    warningBox: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        backgroundColor: colors['error-container'] || '#ffdad6',
        padding: spacing.md,
        borderRadius: shapes.roundedSm,
        marginBottom: spacing.md,
    },
    progressHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: spacing.md,
    },
    safeRouteBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: 'rgba(182, 115, 73, 0.1)',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: shapes.roundedPill,
        borderWidth: 1,
        borderColor: 'rgba(182, 115, 73, 0.2)',
    },
    progressBarBg: {
        width: '100%',
        height: 10,
        backgroundColor: colors['surface-container-high'],
        borderRadius: 5,
        marginBottom: spacing.md,
        overflow: 'hidden',
    },
    progressBarFill: {
        height: '100%',
        backgroundColor: colors.primary,
        borderRadius: 5,
    },
    statsGrid: {
        flexDirection: 'row',
        gap: spacing.md,
        marginBottom: spacing.md,
    },
    updateEtaRow: {
        flexDirection: 'row',
        gap: spacing.sm,
        marginBottom: spacing.md,
    },
    etaInput: {
        flex: 1,
        backgroundColor: colors.white,
        borderWidth: 1,
        borderColor: colors['outline-variant'],
        borderRadius: shapes.roundedMd,
        paddingHorizontal: spacing.md,
        color: colors['on-surface'],
    },
    updateEtaButton: {
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.primary,
        borderRadius: shapes.roundedMd,
        paddingHorizontal: spacing.md,
    },
    statBox: {
        flex: 1,
        backgroundColor: colors['surface-container-low'],
        padding: spacing.md,
        borderRadius: shapes.roundedLg,
        borderWidth: 1,
        borderColor: 'rgba(217, 194, 183, 0.1)',
    },
    statLabel: {
        textTransform: 'uppercase',
        fontWeight: 'bold',
        marginBottom: 4,
    },
    aiBox: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.md,
        backgroundColor: colors['secondary-container'],
        padding: spacing.md,
        borderRadius: shapes.roundedLg,
        marginBottom: spacing.md,
    },
    aiIconWrapper: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: colors.white,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionRow: {
        marginTop: spacing.sm,
    },
    completeBtn: {
        height: 52,
        backgroundColor: colors.primary,
        borderRadius: shapes.roundedPill,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    noJourneyContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.xl,
    },
    startNewBtn: {
        height: 52,
        paddingHorizontal: spacing.xl,
        backgroundColor: colors.primary,
        borderRadius: shapes.roundedPill,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        marginTop: spacing.md,
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        padding: spacing.lg,
    },
    modalContent: {
        backgroundColor: colors.surface,
        borderRadius: shapes.roundedLg,
        padding: spacing.lg,
    },
    modalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: spacing.lg,
    },
    input: {
        borderWidth: 1,
        borderColor: colors.outline,
        borderRadius: shapes.roundedSm,
        padding: spacing.md,
        fontSize: typography.sizes.bodyLg,
        color: colors['on-surface'],
        marginBottom: spacing.lg,
    },
    timerInputs: {
        flexDirection: 'row',
        gap: spacing.sm,
    },
    timerInput: {
        flex: 1,
        minWidth: 0,
        paddingHorizontal: spacing.sm,
    },
    modalSubmitBtn: {
        height: 52,
        backgroundColor: colors.primary,
        borderRadius: shapes.roundedPill,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
