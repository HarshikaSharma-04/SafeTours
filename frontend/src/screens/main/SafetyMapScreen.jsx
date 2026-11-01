import React, { useState, useEffect, useRef } from 'react';
import { View, StyleSheet, TouchableOpacity, TextInput, Dimensions, ActivityIndicator, Linking, ScrollView, Modal, KeyboardAvoidingView, Platform } from 'react-native';
import { Screen } from '../../components/Screen';
import { Text } from '../../components/Text';
import { colors, spacing, shapes, typography } from '../../theme/theme';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import * as Location from 'expo-location';
import { MapComponent, getRiskColors } from '../../components/MapComponent';
import { riskService } from '../../services/riskService';
import { formatScore, confidenceText, dataQualityNote, factorLabel } from '../../utils/riskLevels';
import { locationService } from '../../services/locationService';
import { placesService } from '../../services/places';
import { communityService } from '../../services/communityService';
import { geofenceManager, calculateDistanceMeters } from '../../utils/geofenceManager';
import { LocationStatusModal } from '../../components/LocationStatusModal';
import { useNearbyServices } from '../../context/NearbyContext';
import { NEARBY_TYPES } from '../../services/nearby';
import { OpenChip, nearbyStatusText, typeMeta } from '../../components/NearbyParts';
import { callNumber, openDirections, sanitizePhone } from '../../utils/placeActions';
import { formatDistance, formatAge } from '../../utils/geo';
import { useConnectivity } from '../../context/ConnectivityContext';
import { ensureWatching, getBestPosition } from '../../utils/locationWatcher';
import { locationBus } from '../../utils/locationBus';
import { shareLocation } from '../../utils/shareLocation';
import { useSidebar } from '../../context/SidebarContext';

const { width, height } = Dimensions.get('window');

// Default fallback region
const DEFAULT_REGION = {
    latitude: 18.9220,
    longitude: 72.8347,
    latitudeDelta: 0.03,
    longitudeDelta: 0.03,
};

// Risk cells are loaded around the camera. The radius follows the zoom, within limits that keep a request small.
const MIN_CELL_RADIUS_M = 1500;
const MAX_CELL_RADIUS_M = 6000;
const CAMERA_RELOAD_DISTANCE_M = 800;
const CAMERA_RELOAD_DELAY_MS = 700;
const METERS_PER_DEGREE_LAT = 111320;
// Pins are only drawn once the map is zoomed in far enough for them to be readable.
const MAX_PIN_LATITUDE_DELTA = 0.05;
const LEGEND = [
    { label: 'Safe', color: '#22c55e' },
    { label: 'Low', color: '#facc15' },
    { label: 'Moderate', color: '#f97316' },
    { label: 'High', color: colors.error },
];

const cellRadiusFor = (region) => {
    const half = (Number(region?.latitudeDelta) || 0.03) * METERS_PER_DEGREE_LAT * 0.6;
    return Math.min(MAX_CELL_RADIUS_M, Math.max(MIN_CELL_RADIUS_M, half));
};

const FACTOR_ICONS = {
    crime: 'warning-outline',
    weather: 'cloudy-outline',
    crowd: 'people-outline',
    community: 'shield-outline',
    news: 'newspaper-outline',
};

const typeList = (types = []) => types.map((t) => `${t.type} ${t.incidents}`).join(', ');

// What the crime number is based on: the file's records, or a sample figure, or nothing.
const crimeSourceText = (risk) => {
    const source = risk?.crimeSource;
    if (!source) return risk?.breakdown ? 'Crime: no data for this area.' : null;
    const lead = source.localities?.[0];
    if (!lead) return 'Crime: from incident records.';
    if (lead.source === 'records') {
        return `Crime: based on ${lead.incidents} records for ${lead.locality}: ${typeList(lead.types)}.`;
    }
    return `Crime: sample figure for ${lead.locality}.`;
};

// The headlines behind the news score, newest information first.
const newsText = (risk) => {
    const item = risk?.newsItems?.[0];
    if (!item) return null;
    const more = risk.newsItems.length > 1 ? ` and ${risk.newsItems.length - 1} more` : '';
    return `News: ${item.title} (${item.source})${more}.`;
};

// One chip per risk component. A component without usable data shows "—", never 0.
const FactorChips = ({ risk }) => {
    const breakdown = risk?.breakdown || {};
    const details = risk?.componentDetails || {};
    const note = dataQualityNote(risk);
    const crimeText = crimeSourceText(risk);
    const newsLine = newsText(risk);
    return (
        <>
            <View style={styles.factorGrid}>
                {Object.keys(FACTOR_ICONS).map((key) => (
                    <View key={key} style={styles.factorChip}>
                        <Ionicons name={FACTOR_ICONS[key]} size={14} color={colors.primary} />
                        <Text variant="labelSm" color={colors['on-surface-variant']}>{factorLabel(key)}:</Text>
                        <Text variant="labelSm" style={{ fontWeight: 'bold' }}>
                            {key === 'community' && details.community?.noReports
                                ? 'no reports'
                                : `${formatScore(breakdown[key])}${key === 'community' && details.community?.reports ? ` (${details.community.reports} report${details.community.reports === 1 ? '' : 's'})` : ''}`}
                            {details[key]?.stale ? ' (old)' : ''}
                        </Text>
                    </View>
                ))}
                {risk?.modifiers && (
                    <View style={styles.factorChip}>
                        <Ionicons name="time-outline" size={14} color={colors.primary} />
                        <Text variant="labelSm" color={colors['on-surface-variant']}>Time:</Text>
                        <Text variant="labelSm" style={{ fontWeight: 'bold' }}>
                            {`${risk.modifiers.time.label} ×${risk.modifiers.combinedMultiplier}`}
                        </Text>
                    </View>
                )}
                {confidenceText(risk) && (
                    <View style={styles.factorChip}>
                        <Ionicons name="analytics-outline" size={14} color={colors.primary} />
                        <Text variant="labelSm" color={colors['on-surface-variant']}>Data confidence:</Text>
                        <Text variant="labelSm" style={{ fontWeight: 'bold' }}>{confidenceText(risk)}</Text>
                    </View>
                )}
            </View>
            {crimeText && (
                <Text variant="labelSm" color={colors['on-surface-variant']} style={{ marginTop: 4 }}>
                    {crimeText}
                </Text>
            )}
            {newsLine && (
                <Text variant="labelSm" color={colors['on-surface-variant']} style={{ marginTop: 4 }}>
                    {newsLine}
                </Text>
            )}
            {note && (
                <Text variant="labelSm" color={risk?.lowConfidence ? colors.error : colors['on-surface-variant']} style={{ marginTop: 4 }}>
                    {note}
                </Text>
            )}
        </>
    );
};

const QuickAction = ({ icon, label, onPress, primary = false }) => (
    <TouchableOpacity style={styles.quickAction} onPress={onPress} accessibilityLabel={label}>
        <View style={[styles.quickIcon, primary && { backgroundColor: colors.primary }]}>
            <Ionicons name={icon} size={20} color={primary ? colors['on-primary'] : colors.primary} />
        </View>
        <Text variant="labelSm" color={colors['on-surface']} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
);

export const SafetyMapScreen = ({ route }) => {
    const navigation = useNavigation();
    const { toggleDrawer } = useSidebar();
    const [searchQuery, setSearchQuery] = useState('');

    // ── Destination Search States ──────────────────────────────────────────────
    const [isSearchFocused, setIsSearchFocused] = useState(false);
    const [isSearching, setIsSearching] = useState(false);
    const [searchError, setSearchError] = useState(null);
    const [suggestions, setSuggestions] = useState([]);
    const [isSuggestionsLoading, setIsSuggestionsLoading] = useState(false);
    const [destination, setDestination] = useState(null); // { latitude, longitude, name, address }
    const [destinationRisk, setDestinationRisk] = useState(null); // high-risk cells near the destination
    const [destinationDistance, setDestinationDistance] = useState(null); // meters from user
    const [showDestinationPanel, setShowDestinationPanel] = useState(false);
    const autocompleteTimerRef = useRef(null);
    
    // ── Single-Source-Of-Truth Location Risk States (Python Score Engine) ──────
    const [destinationRiskData, setDestinationRiskData] = useState(null);
    const [isDestinationRiskLoading, setIsDestinationRiskLoading] = useState(false);
    const [destinationRiskError, setDestinationRiskError] = useState(null);

    const [currentLocationRiskData, setCurrentLocationRiskData] = useState(null);
    const [isCurrentRiskLoading, setIsCurrentRiskLoading] = useState(false);
    const [currentRiskError, setCurrentRiskError] = useState(null);
    // Panel visibility: user must tap "View Location Risk" to see current risk details
    const [showCurrentRiskPanel, setShowCurrentRiskPanel] = useState(false);
    // ─────────────────────────────────────────────────────────────────────────
    const [bottomSheetExpanded, setBottomSheetExpanded] = useState(false);
    const [sheetHeight, setSheetHeight] = useState(220);
    const [showMapOptions, setShowMapOptions] = useState(false);
    
    // Map & Location states
    const [userLocation, setUserLocation] = useState(null);
    const [locationAccuracy, setLocationAccuracy] = useState(10);
    const [lastUpdateTime, setLastUpdateTime] = useState(null);
    const [mapRegion, setMapRegion] = useState(DEFAULT_REGION);
    const [mapType, setMapType] = useState('standard');
    const conn = useConnectivity();
    const [riskMeta, setRiskMeta] = useState(null); // { source, fetchedAt } of the displayed risk cells
    
    // Tracking & Permission states
    const [permissionStatus, setPermissionStatus] = useState('checking'); // checking, granted, denied, permanently_denied, disabled, error
    const [browseWithoutLocation, setBrowseWithoutLocation] = useState(false);
    const [trackingActive, setTrackingActive] = useState(false);
    const [isLoadingLocation, setIsLoadingLocation] = useState(false);
    const [errorMessage, setErrorMessage] = useState(null);

    // Danger Zone integration states
    const [dangerZones, setDangerZones] = useState([]);
    const [selectedZone, setSelectedZone] = useState(null);
    const [isLoadingDangerZones, setIsLoadingDangerZones] = useState(false);
    const [dangerZoneError, setDangerZoneError] = useState(null);
    const [cellCoverage, setCellCoverage] = useState(null); // what the last cell request found: { scanned, unknownCells }
    const [selectedZoneRisk, setSelectedZoneRisk] = useState(null); // full risk of the tapped cell
    const [isZoneRiskLoading, setIsZoneRiskLoading] = useState(false);
    const [tilesFailed, setTilesFailed] = useState(false);

    // Geofencing UI Feedback Toast
    const [geofenceToast, setGeofenceToast] = useState(null);
    const [geofenceResult, setGeofenceResult] = useState(geofenceManager.lastResult);

    // Diagnostics Status Modal State
    const [showStatusModal, setShowStatusModal] = useState(false);

    // Community Incidents states
    const [communityIncidents, setCommunityIncidents] = useState([]);
    const [queuedReports, setQueuedReports] = useState([]); // saved on this phone, waiting for a connection
    const [showCommunityFeed, setShowCommunityFeed] = useState(false);
    const [showReportModal, setShowReportModal] = useState(false);
    const [selectedIncidentType, setSelectedIncidentType] = useState('Harassment');
    const [reportCategories, setReportCategories] = useState([]); // from the server's single category list
    const [incidentDescription, setIncidentDescription] = useState('');
    const [isSubmittingIncident, setIsSubmittingIncident] = useState(false);
    const [incidentMessage, setIncidentMessage] = useState(null);
    const [isLoadingCommunity, setIsLoadingCommunity] = useState(false);
    const [communityError, setCommunityError] = useState(null);

    // Nearby emergency services (shared lookup, refreshed only on a new cell / >1 km)
    const nearby = useNearbyServices();
    const [visibleTypes, setVisibleTypes] = useState(() => new Set(NEARBY_TYPES.map((t) => t.key)));
    const [selectedPlace, setSelectedPlace] = useState(null);
    const toggleType = (key) => setVisibleTypes((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });
    const mapPlaces = mapRegion.latitudeDelta > MAX_PIN_LATITUDE_DELTA
        ? []
        : (nearby?.places || []).filter((p) => visibleTypes.has(p.type)).slice(0, 80);

    const mapRef = useRef(null);
    const lastSyncedCoords = useRef(null);
    const cameraRef = useRef(DEFAULT_REGION); // where the map is looking now; the risk cells follow it
    const lastCellCenter = useRef(null);
    const cameraTimerRef = useRef(null);
    const searchSeq = useRef(0); // only the newest search may show its results

    // ── Destination Search Handlers ────────────────────────────────────────────

    // ── Single Source of Truth Risk Fetching Helpers ───────────────────────────
    const fetchDestinationRiskData = async (latitude, longitude) => {
        setIsDestinationRiskLoading(true);
        setDestinationRiskError(null);

        const res = await riskService.getLocationRisk(latitude, longitude);
        if (res.success && res.data) {
            setDestinationRiskData(res.data);
        } else {
            setDestinationRiskError(res.error?.message || 'Unable to retrieve location risk score from Risk Score Engine.');
        }
        setIsDestinationRiskLoading(false);
    };

    const fetchCurrentLocationRiskData = async (latitude, longitude) => {
        setIsCurrentRiskLoading(true);
        setCurrentRiskError(null);
        const res = await riskService.getLocationRisk(latitude, longitude);
        if (res.success && res.data) {
            setCurrentLocationRiskData(res.data);
        } else {
            setCurrentRiskError(res.error?.message || 'Unable to retrieve current location risk score from Risk Score Engine.');
        }
        setIsCurrentRiskLoading(false);
    };

    /**
     * Debounced autocomplete: asks for suggestions ~500 ms after the user stops typing.
     * Each suggestion already has its coordinates, so picking one never has to search again.
     */
    const handleSearchTextChange = (text) => {
        setSearchQuery(text);
        setSearchError(null);

        // Clear destination when user edits the query
        if (destination) {
            setDestination(null);
            setDestinationRisk(null);
            setDestinationRiskData(null);
            setDestinationRiskError(null);
            setDestinationDistance(null);
            setShowDestinationPanel(false);
        }

        if (autocompleteTimerRef.current) {
            clearTimeout(autocompleteTimerRef.current);
        }

        const seq = ++searchSeq.current;
        if (!text || text.trim().length < 2) {
            setSuggestions([]);
            setIsSuggestionsLoading(false);
            return;
        }

        setIsSuggestionsLoading(true);
        autocompleteTimerRef.current = setTimeout(async () => {
            const res = await placesService.search(text, userLocation);
            if (seq !== searchSeq.current) return;
            setSuggestions(res.data || []);
            setIsSuggestionsLoading(false);
        }, 500);
    };

    /** Puts the camera, the marker and the risk panel on a chosen place. */
    const showDestination = async (place) => {
        const { latitude, longitude } = place;
        const dest = {
            latitude,
            longitude,
            name: place.name || searchQuery,
            address: place.address || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
        };
        setDestination(dest);
        setSearchQuery(dest.name);

        const destRegion = { latitude, longitude, latitudeDelta: 0.02, longitudeDelta: 0.02 };
        setMapRegion(destRegion);
        mapRef.current?.animateToRegion(destRegion, 1000);

        if (userLocation) {
            setDestinationDistance(calculateDistanceMeters(userLocation.latitude, userLocation.longitude, latitude, longitude));
        }

        fetchDestinationRiskData(latitude, longitude);

        const riskRes = await riskService.getCellsAround(latitude, longitude, 3000, 'HIGH');
        setDestinationRisk(riskRes.success ? riskRes.data || [] : []);

        // Location details open only when the user taps the marker or "View Details".
        setShowDestinationPanel(false);
    };

    /**
     * Called when the user submits the search bar: uses the top suggestion for what they typed.
     */
    const handleSearchDestination = async () => {
        const query = searchQuery.trim();
        if (!query) return;

        if (autocompleteTimerRef.current) clearTimeout(autocompleteTimerRef.current);
        searchSeq.current += 1;
        setSuggestions([]);
        setIsSuggestionsLoading(false);
        setIsSearchFocused(false);
        setIsSearching(true);
        setSearchError(null);
        setShowDestinationPanel(false);

        try {
            const res = await placesService.search(query, userLocation);
            if (!res.success) {
                setSearchError(res.error?.message || 'Place search is not available right now.');
            } else if (!res.data.length) {
                setSearchError(`No location found for "${query}". Please try a different search.`);
            } else {
                await showDestination(res.data[0]);
            }
        } catch (err) {
            console.error('[Destination Search] Error:', err);
            setSearchError('An error occurred while searching. Please try again.');
        } finally {
            setIsSearching(false);
        }
    };

    /**
     * Triggered when user taps destination marker or "View Details" chip
     */
    const handleOpenDestinationDetails = () => {
        setShowDestinationPanel(true);
        setBottomSheetExpanded(true);
    };

    /**
     * Tap a suggestion: its coordinates are already known.
     */
    const handleSelectSuggestion = (suggestion) => {
        searchSeq.current += 1;
        setSuggestions([]);
        setIsSearchFocused(false);
        setSearchError(null);
        showDestination(suggestion);
    };

    /**
     * Clear the destination and reset search state
     */
    const handleClearDestination = () => {
        setDestination(null);
        setDestinationRisk(null);
        setDestinationRiskData(null);
        setDestinationRiskError(null);
        setIsDestinationRiskLoading(false);
        setDestinationDistance(null);
        setShowDestinationPanel(false);
        setSearchQuery('');
        setSuggestions([]);
        setSearchError(null);
        // Restore camera to user location if available
        if (userLocation) {
            const userRegion = {
                ...userLocation,
                latitudeDelta: 0.02,
                longitudeDelta: 0.02,
            };
            setMapRegion(userRegion);
            mapRef.current?.animateToRegion(userRegion, 800);
        }
    };

    // ─────────────────────────────────────────────────────────────────────────

    const loadCommunityIncidents = async (coordinates = null, { silent = false } = {}) => {
        if (!silent) setIsLoadingCommunity(true);
        setCommunityError(null);
        // No fallback place: without a position there is nothing to look up.
        const lat = coordinates?.latitude ?? userLocation?.latitude;
        const lng = coordinates?.longitude ?? userLocation?.longitude;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            setCommunityError('Your location is not available yet, so nearby reports cannot be loaded.');
            setIsLoadingCommunity(false);
            return;
        }
        const res = await communityService.getNearbyIncidents(lat, lng, 5000);
        if (res.success) {
            setCommunityIncidents(res.data || []);
            // A report the outbox has uploaded is now in this list, so its local copy must not count twice.
            if (!conn.isOffline) setQueuedReports([]);
        } else if (!silent) {
            setCommunityError(res.error?.message || 'Could not load nearby community reports.');
        }
        setIsLoadingCommunity(false);
    };

    const handleReportIncidentSubmit = async () => {
        if (!incidentDescription || incidentDescription.trim().length < 5) {
            setIncidentMessage('Please enter a description of at least 5 characters.');
            return;
        }

        setIsSubmittingIncident(true);
        setIncidentMessage(null);

        // A report is tied to where the user really is. There is no fallback place: without a fix we say so.
        const lat = userLocation?.latitude;
        const lng = userLocation?.longitude;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            setIncidentMessage('Your location is not available yet. Turn on location and try again.');
            setIsSubmittingIncident(false);
            return;
        }

        const res = await communityService.reportIncident({
            incidentType: selectedIncidentType,
            description: incidentDescription.trim(),
            latitude: lat,
            longitude: lng,
        });

        setIsSubmittingIncident(false);

        if (res.success) {
            setIncidentDescription('');
            setShowReportModal(false);

            // The count moves at once, whatever happens to the refresh below.
            if (res.queued) {
                setQueuedReports((prev) => [{
                    _id: `queued-${Date.now()}`,
                    queued: true,
                    incidentType: selectedIncidentType,
                    description: incidentDescription.trim(),
                    latitude: lat,
                    longitude: lng,
                    createdAt: new Date().toISOString(),
                }, ...prev]);
            } else if (res.data?._id) {
                setCommunityIncidents((prev) => [res.data, ...prev.filter((inc) => inc._id !== res.data._id)]);
            }

            setGeofenceToast(
                res.queued ? `Saved offline: ${selectedIncidentType} will be reported when you are online`
                : res.data?.merged ? `Added to a matching report nearby: ${selectedIncidentType}`
                : `Incident reported: ${selectedIncidentType}`
            );
            setTimeout(() => setGeofenceToast(null), 4000);

            if (!res.queued) {
                // The server has already rescored this area, so the risk shown can include this report straight away.
                loadCommunityIncidents({ latitude: lat, longitude: lng }, { silent: true });
                fetchCurrentLocationRiskData(lat, lng);
                loadDangerZones(null, true);
                if (selectedZone?.h3Index) {
                    riskService.getCell(selectedZone.h3Index).then((r) => { if (r.success && r.data) setSelectedZoneRisk(r.data); });
                }
            }
        } else {
            setIncidentMessage(res.error?.message || 'Failed to report incident.');
        }
    };

    const handleConfirmIncident = async (incidentId) => {
        setIsLoadingCommunity(true);
        setCommunityError(null);
        const res = await communityService.confirmIncident(incidentId);
        if (res.success) {
            loadCommunityIncidents();
        } else {
            setCommunityError(res.error?.message || 'Could not confirm this incident.');
            setIsLoadingCommunity(false);
        }
    };

    const handleReportFalse = async (incidentId) => {
        setIsLoadingCommunity(true);
        setCommunityError(null);
        const res = await communityService.reportFalse(incidentId);
        if (res.success) {
            loadCommunityIncidents();
        } else {
            setCommunityError(res.error?.message || 'Could not flag this incident.');
            setIsLoadingCommunity(false);
        }
    };

    // Backend geofence results (the app only sends readings; detection happens on the server).
    useEffect(() => {
        const off = geofenceManager.on('result', (r) => {
            setGeofenceResult(r);
            if (r.event === 'ENTER' || r.event === 'EXIT' || r.event === 'ZONE_CHANGED') {
                setGeofenceToast(r.message);
                setTimeout(() => setGeofenceToast(null), 4000);
            }
        });
        const offLow = geofenceManager.on('lowAccuracy', ({ accuracy }) => {
            setGeofenceToast(Number.isFinite(accuracy) ? `GPS accuracy is low (${Math.round(accuracy)} m): risk alerts paused` : 'GPS accuracy is unknown: risk alerts paused');
            setTimeout(() => setGeofenceToast(null), 3000);
        });
        return () => { off(); offLow(); };
    }, []);

    // Initial check/request on mount
    useEffect(() => {
        requestLocationPermission();
        // One GPS watch for the whole app (utils/locationWatcher.js): the map only listens to it.
        const off = locationBus.subscribe(handleNewLocationFix);
        return () => {
            off();
            if (cameraTimerRef.current) clearTimeout(cameraTimerRef.current);
            if (autocompleteTimerRef.current) clearTimeout(autocompleteTimerRef.current);
        };
    }, []);

    useEffect(() => {
        // Community Feed is an existing map feature. A sidebar navigation
        // request simply opens this UI instead of creating another screen.
        if (route?.params?.communityRequestId) {
            loadCommunityIncidents();
            setShowCommunityFeed(true);
        }
    }, [route?.params?.communityRequestId]);

    // Periodic background refresh of the risk cells where the map is looking (every 30 seconds)
    useEffect(() => {
        const autoRefreshInterval = setInterval(() => {
            loadDangerZones(null, true);
            // Other people's reports appear without a manual refresh.
            const last = locationBus.getLast();
            if (last) loadCommunityIncidents(last, { silent: true });
        }, 30000);

        return () => clearInterval(autoRefreshInterval);
    }, []);

    // The camera stopped: load the cells there, unless it only moved a little at the same zoom.
    const handleRegionChangeComplete = (region) => {
        setMapRegion(region);
        cameraRef.current = region;
        if (cameraTimerRef.current) clearTimeout(cameraTimerRef.current);
        cameraTimerRef.current = setTimeout(() => {
            const last = lastCellCenter.current;
            const radius = cellRadiusFor(region);
            const moved = last ? calculateDistanceMeters(last.latitude, last.longitude, region.latitude, region.longitude) : Infinity;
            if (moved > CAMERA_RELOAD_DISTANCE_M || !last || radius > last.radius) loadDangerZones(null, true);
        }, CAMERA_RELOAD_DELAY_MS);
    };

    const requestLocationPermission = async () => {
        try {
            setPermissionStatus('checking');
            setErrorMessage(null);

            const servicesEnabled = await Location.hasServicesEnabledAsync();
            if (!servicesEnabled) {
                setPermissionStatus('disabled');
                setErrorMessage('GPS/location services are disabled. Please enable location services on your device.');
                return;
            }

            const { status: existingStatus } = await Location.getForegroundPermissionsAsync();
            
            if (existingStatus === 'granted') {
                setPermissionStatus('granted');
                await startLiveTracking();
                return;
            }

            const { status: requestedStatus } = await Location.requestForegroundPermissionsAsync();
            if (requestedStatus === 'granted') {
                setPermissionStatus('granted');
                await startLiveTracking();
            } else {
                const { canAskAgain } = await Location.getForegroundPermissionsAsync();
                if (!canAskAgain) {
                    setPermissionStatus('permanently_denied');
                } else {
                    setPermissionStatus('denied');
                }
            }
        } catch (error) {
            console.error('Error requesting location permission:', error);
            setPermissionStatus('error');
            setErrorMessage('An unexpected error occurred while requesting location permissions.');
        }
    };

    /**
     * Start following the shared GPS watch. Without a first fix the map stays usable, centred on the default region.
     */
    const startLiveTracking = async () => {
        setIsLoadingLocation(true);
        setErrorMessage(null);
        try {
            await ensureWatching();
            setTrackingActive(true);

            const location = locationBus.getLast()
                ? { coords: locationBus.getLast(), timestamp: locationBus.getLast().timestamp }
                : await getBestPosition();

            if (!location) {
                setErrorMessage('Waiting for a GPS signal. The map keeps working in the meantime.');
                loadDangerZones(DEFAULT_REGION, true);
                return;
            }

            handleNewLocationFix(location);

            const initialCoords = {
                latitude: location.coords.latitude,
                longitude: location.coords.longitude,
            };
            const newRegion = {
                ...initialCoords,
                latitudeDelta: 0.02,
                longitudeDelta: 0.02,
            };
            setMapRegion(newRegion);
            cameraRef.current = newRegion;
            mapRef.current?.animateToRegion(newRegion, 1000);

            fetchCurrentLocationRiskData(initialCoords.latitude, initialCoords.longitude);
            loadDangerZones(newRegion);
            loadCommunityIncidents(initialCoords);
        } catch (error) {
            console.error('Error starting live tracking:', error);
            setErrorMessage('Could not start live tracking. Tap the location button to try again.');
        } finally {
            setIsLoadingLocation(false);
        }
    };

    /**
     * Handle incoming GPS location fixes smoothly
     */
    const handleNewLocationFix = (fix) => {
        // Accepts both shapes: a raw expo-location result, and the flat object the locationBus publishes.
        const location = fix?.coords ? fix : fix ? { coords: fix, timestamp: fix.timestamp } : null;
        if (!location || !location.coords) return;

        const coords = {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
        };

        setUserLocation(coords);
        setLocationAccuracy(location.coords.accuracy || 10);
        const isoTime = new Date(location.timestamp || Date.now()).toISOString();
        setLastUpdateTime(isoTime);

        // Send location update to backend if moved significantly (> 20 meters)
        if (
            !lastSyncedCoords.current ||
            calculateDistanceMeters(
                lastSyncedCoords.current.latitude,
                lastSyncedCoords.current.longitude,
                coords.latitude,
                coords.longitude
            ) > 20
        ) {
            lastSyncedCoords.current = coords;
            locationService.syncLocation({
                latitude: coords.latitude,
                longitude: coords.longitude,
                accuracy: location.coords.accuracy,
                speed: location.coords.speed,
                heading: location.coords.heading,
                timestamp: isoTime,
            });
        }
    };

    // `target` is any { latitude, longitude, latitudeDelta? }; without one, the cells follow the camera.
    const loadDangerZones = async (target = null, isSilent = false) => {
        const area = target || cameraRef.current;
        const lat = area?.latitude;
        const lng = area?.longitude;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        if (!isSilent) setIsLoadingDangerZones(true);
        setDangerZoneError(null);

        const radius = cellRadiusFor(area);
        lastCellCenter.current = { latitude: lat, longitude: lng, radius };

        // SAFE cells are drawn too: the legend shows them, and green tells the user the area was actually checked.
        const res = await riskService.getCellsAround(lat, lng, radius, 'SAFE');
        if (res.success) {
            setDangerZones(res.data || []);
            setCellCoverage({ scanned: res.meta?.scanned ?? null, unknownCells: res.meta?.unknownCells ?? 0 });
            setRiskMeta(res.meta?.source === 'device' ? { source: 'device', fetchedAt: res.meta.fetchedAt } : { source: 'server', fetchedAt: Date.now() });
        } else {
            setDangerZoneError(res.error?.message || 'Failed to load risk cells');
        }

        if (!isSilent) setIsLoadingDangerZones(false);
    };

    const handleRecenter = async () => {
        if (permissionStatus !== 'granted') {
            await requestLocationPermission();
            return;
        }

        if (userLocation) {
            const targetRegion = {
                ...userLocation,
                latitudeDelta: 0.015,
                longitudeDelta: 0.015,
            };
            mapRef.current?.animateToRegion(targetRegion, 1000);
            cameraRef.current = targetRegion;
        } else {
            await startLiveTracking();
        }
    };

    useEffect(() => {
        communityService.getCategories().then(setReportCategories);
    }, []);

    // Reload the cells when the connection drops or returns: cached cells while offline, fresh ones when back.
    const offlineRef = useRef(conn.isOffline);
    useEffect(() => {
        if (offlineRef.current === conn.isOffline) return;
        offlineRef.current = conn.isOffline;
        loadDangerZones(null, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [conn.isOffline]);

    const handleSelectZone = async (zone) => {
        setSelectedZone(zone);
        setSelectedZoneRisk(null);
        setShowDestinationPanel(false);
        setShowCurrentRiskPanel(true);
        setBottomSheetExpanded(true);

        // The list only carries the summary; the factors shown in the panel come from the full cell result.
        if (zone.h3Index) {
            setIsZoneRiskLoading(true);
            const res = await riskService.getCell(zone.h3Index);
            if (res.success && res.data) setSelectedZoneRisk(res.data);
            setIsZoneRiskLoading(false);
        }
    };

    const clearSelectedZone = () => {
        setSelectedZone(null);
        setSelectedZoneRisk(null);
        setShowCurrentRiskPanel(false);
    };

    // The search box is for destinations, so it does not filter the map cells.
    const filteredDangerZones = dangerZones;

    const insideCell = geofenceResult?.insideDangerZone ? dangerZones.find((z) => z.h3Index === geofenceResult.h3Index) : null;
    const activeZone = selectedZone || insideCell || null;
    const activeRiskColors = getRiskColors(activeZone?.riskLevel);
    // Backend risk result -> what the panels render. score is null when the level is UNKNOWN.
    const buildRiskInfo = (data) => {
        if (!data) return null;
        const level = data.riskLevel || 'UNKNOWN';
        const palette = getRiskColors(level);
        return { score: data.totalRiskScore, level, label: palette.label, colors: palette, risk: data };
    };
    const destinationRiskInfo = buildRiskInfo(destinationRiskData);
    const currentLocationRiskInfo = buildRiskInfo(currentLocationRiskData);
    // What the risk panel shows: the tapped cell when there is one, otherwise where the user is.
    const panelRiskData = selectedZone ? (selectedZoneRisk || selectedZone) : currentLocationRiskData;
    const panelRiskInfo = buildRiskInfo(panelRiskData);

    // One quiet line in the sheet for anything the map cannot show right now.
    const mapNotice = (() => {
        if (conn.isOffline || riskMeta?.source === 'device') {
            return riskMeta?.source === 'device' && dangerZones.length
                ? `Offline: saved risk data from ${formatAge(Date.now() - riskMeta.fetchedAt) || 'just now'}`
                : 'Offline: download this area in Settings to see risk here';
        }
        if (tilesFailed) return 'Base map not available right now';
        if (!dangerZones.length && !isLoadingDangerZones && cellCoverage) {
            return cellCoverage.scanned === 0 ? 'SafeTours covers Mumbai: search a Mumbai place' : 'Not enough data to rate this area yet';
        }
        return null;
    })();

    // Everyone who has reported nearby: each report, each person who confirmed one, and reports waiting to upload.
    const allReports = [...queuedReports, ...communityIncidents];
    const reportCount = allReports.reduce((total, inc) => total + 1 + (inc.confirmationCount || 0), 0);

    const openReport = () => {
        setIncidentMessage(null);
        if (reportCategories.length && !reportCategories.includes(selectedIncidentType)) setSelectedIncidentType(reportCategories[0]);
        setShowReportModal(true);
    };

    return (
        <Screen style={styles.container} isSafe={false}>
            {/* Map Component */}
            <MapComponent 
                ref={mapRef}
                region={mapRegion}
                onRegionChangeComplete={handleRegionChangeComplete}
                userLocation={userLocation}
                destinationMarker={destination}
                onSelectDestination={handleOpenDestinationDetails}
                mapType={mapType}
                bottomInset={sheetHeight}
                onTilesStatus={(status) => setTilesFailed(status === 'failed')}
                dangerZones={filteredDangerZones}
                communityIncidents={allReports}
                selectedZone={activeZone}
                onSelectZone={handleSelectZone}
                nearbyPlaces={mapPlaces}
                onSelectPlace={setSelectedPlace}
            />

            {/* Top Search Bar */}
            <View style={styles.topSearchContainer}>
                <View style={styles.searchHeaderRow}>
                    <TouchableOpacity style={styles.menuButton} onPress={toggleDrawer} accessibilityLabel="Open menu">
                        <Ionicons name="menu" size={26} color={colors.primary} />
                    </TouchableOpacity>
                    <View style={styles.searchBar}>
                        <Ionicons name="search" size={20} color={colors['on-surface-variant']} />
                        <TextInput 
                            style={styles.searchInput}
                            placeholder="Search a place in Mumbai"
                            placeholderTextColor={colors['on-surface-variant']}
                            value={searchQuery}
                            onChangeText={handleSearchTextChange}
                            onFocus={() => {
                                setIsSearchFocused(true);
                                // Collapse and hide bottom sheet so keyboard doesn't overlap search
                                setBottomSheetExpanded(false);
                                setShowDestinationPanel(false);
                            }}
                            onBlur={() => setIsSearchFocused(false)}
                            onSubmitEditing={handleSearchDestination}
                            returnKeyType="search"
                            blurOnSubmit={false}
                        />
                        {isSearching ? (
                            <ActivityIndicator size="small" color={colors.primary} style={{ padding: spacing.xs }} />
                        ) : searchQuery ? (
                            <TouchableOpacity style={styles.micButton} onPress={handleClearDestination}>
                                <Ionicons name="close-circle" size={20} color={colors.outline} />
                            </TouchableOpacity>
                        ) : (
                            <TouchableOpacity style={styles.micButton} onPress={handleSearchDestination}>
                                <Ionicons name="arrow-forward-circle" size={22} color={colors.primary} />
                            </TouchableOpacity>
                        )}
                    </View>
                </View>

                {/* Autocomplete Suggestions Dropdown */}
                {isSearchFocused && (suggestions.length > 0 || isSuggestionsLoading) && (
                    <View style={styles.autocompleteDropdown}>
                        {isSuggestionsLoading ? (
                            <View style={styles.autocompleteItem}>
                                <ActivityIndicator size="small" color={colors.primary} />
                                <Text variant="bodyMd" color={colors['on-surface-variant']} style={{ marginLeft: 10 }}>
                                    Finding locations...
                                </Text>
                            </View>
                        ) : (
                            <ScrollView
                                keyboardShouldPersistTaps="handled"
                                showsVerticalScrollIndicator={false}
                                bounces={false}
                                style={{ maxHeight: 200 }}
                            >
                                {suggestions.map((item, idx) => (
                                    <TouchableOpacity
                                        key={`${item.latitude}_${item.longitude}_${idx}`}
                                        style={styles.autocompleteItem}
                                        onPress={() => handleSelectSuggestion(item)}
                                    >
                                        <Ionicons name="location-outline" size={18} color={colors.primary} />
                                        <Text variant="bodyMd" style={{ flex: 1, color: colors['on-surface'] }} numberOfLines={1}>
                                            {item.name}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </ScrollView>
                        )}
                    </View>
                )}

                {/* Search Error Banner */}
                {searchError && (
                    <View style={styles.searchErrorBanner}>
                        <Ionicons name="alert-circle" size={18} color={colors.error} />
                        <Text variant="bodyMd" style={{ color: colors.error, flex: 1 }}>
                            {searchError}
                        </Text>
                        <TouchableOpacity onPress={() => setSearchError(null)}>
                            <Ionicons name="close" size={16} color={colors.error} />
                        </TouchableOpacity>
                    </View>
                )}

                {/* Geofence Event Alert Toast Banner */}
                {geofenceToast && (
                    <View style={styles.geofenceToastBanner}>
                        <Ionicons name="notifications-outline" size={18} color={colors['on-primary']} />
                        <Text variant="labelLg" style={{ color: colors['on-primary'], fontWeight: 'bold', flex: 1 }}>
                            {geofenceToast}
                        </Text>
                    </View>
                )}
            </View>

            {/* Location and SOS sit just above the sheet, whatever its height */}
            {!isSearchFocused && (
                <View style={[styles.fabColumn, { bottom: sheetHeight + spacing.sm }]} pointerEvents="box-none">
                    <TouchableOpacity style={styles.fabSmall} onPress={handleRecenter} accessibilityLabel="Go to my location">
                        <Ionicons name="locate" size={22} color={colors['on-surface-variant']} />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.sosFab} onPress={() => navigation.navigate('SOS')} accessibilityLabel="Open SOS">
                        <Ionicons name="warning" size={26} color={colors['on-error']} />
                    </TouchableOpacity>
                </View>
            )}

            {/* Location Permission Fallback Overlay */}
            {permissionStatus !== 'granted' && !browseWithoutLocation && (
                <View style={styles.permissionOverlay}>
                    <View style={styles.permissionCard}>
                        <View style={styles.permissionIconContainer}>
                            <Ionicons 
                                name={permissionStatus === 'disabled' ? "location-outline" : "lock-closed-outline"} 
                                size={32} 
                                color={colors.primary} 
                            />
                        </View>
                        <Text variant="headlineSm" style={styles.permissionTitle}>
                            {permissionStatus === 'checking' && "Checking Location Status..."}
                            {permissionStatus === 'disabled' && "Location Services Disabled"}
                            {permissionStatus === 'denied' && "Location Access Required"}
                            {permissionStatus === 'permanently_denied' && "Permission Permanently Denied"}
                            {permissionStatus === 'error' && "Location Error"}
                        </Text>
                        <Text variant="bodyMd" color={colors['on-surface-variant']} style={styles.permissionMessage}>
                            {permissionStatus === 'checking' && "Please wait while we establish location permissions."}
                            {permissionStatus === 'disabled' && "GPS/Location services are disabled on your device. Please enable location to find safe zones around you."}
                            {permissionStatus === 'denied' && "SafeTours requires access to your location to display your position and navigate safely."}
                            {permissionStatus === 'permanently_denied' && "Location permission was permanently denied. Please navigate to settings to grant location access manually."}
                            {permissionStatus === 'error' && (errorMessage || "An unexpected error occurred while loading map coordinates.")}
                        </Text>
                        
                        {permissionStatus !== 'checking' && (
                            <TouchableOpacity 
                                style={styles.permissionButton} 
                                onPress={
                                    permissionStatus === 'permanently_denied' 
                                        ? () => Linking.openSettings() 
                                        : requestLocationPermission
                                }
                            >
                                <Text variant="labelLg" color={colors['on-primary']} style={{ fontWeight: 'bold' }}>
                                    {permissionStatus === 'permanently_denied' ? "Open Settings" : "Grant Permission"}
                                </Text>
                            </TouchableOpacity>
                        )}
                        {permissionStatus !== 'checking' && (
                            <TouchableOpacity
                                style={{ marginTop: spacing.md, padding: spacing.xs }}
                                onPress={() => {
                                    setBrowseWithoutLocation(true);
                                    loadDangerZones(DEFAULT_REGION, true);
                                }}
                            >
                                <Text variant="labelLg" color={colors.primary} style={{ fontWeight: 'bold' }}>
                                    Browse the map without my location
                                </Text>
                            </TouchableOpacity>
                        )}
                        {permissionStatus === 'checking' && (
                            <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: spacing.md }} />
                        )}
                    </View>
                </View>
            )}

            {/* Bottom Sheet Drawer — hidden while search is focused */}
            {!isSearchFocused && (
            <View style={styles.bottomSheet} onLayout={(e) => setSheetHeight(e.nativeEvent.layout.height)}>
                <TouchableOpacity
                    style={styles.sheetHandleContainer}
                    onPress={() => {
                        setShowDestinationPanel(false);
                        clearSelectedZone();
                    }}
                    accessibilityLabel="Close details"
                >
                    <View style={styles.sheetHandle} />
                </TouchableOpacity>

                {/* Destination Details Card (Shown when a destination is searched) */}
                {destination && showDestinationPanel && (
                    <View style={styles.destinationCard}>
                        {/* Fixed header with place name and close button */}
                        <View style={styles.destinationCardHeader}>
                            <View style={{ flex: 1, paddingRight: 8 }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                                    <Ionicons name="location-sharp" size={16} color="#e11d48" />
                                    <Text variant="labelMd" color={colors.primary} style={{ textTransform: 'uppercase', fontWeight: 'bold' }}>
                                        Searched Destination
                                    </Text>
                                </View>
                                <Text variant="headlineSm" style={{ fontWeight: 'bold' }} numberOfLines={1}>
                                    {destination.name}
                                </Text>
                            </View>
                            <TouchableOpacity style={styles.clearDestBtn} onPress={handleClearDestination}>
                                <Ionicons name="close-circle" size={24} color={colors.outline} />
                            </TouchableOpacity>
                        </View>

                        {/* Scrollable body so content never overflows the screen */}
                        <ScrollView
                            style={styles.destinationCardBody}
                            showsVerticalScrollIndicator={false}
                            keyboardShouldPersistTaps="handled"
                        >
                            {/* Address & Coords */}
                            {destination.address ? (
                                <Text variant="bodyMd" color={colors['on-surface-variant']} style={{ marginBottom: 2 }} numberOfLines={2}>
                                    {destination.address}
                                </Text>
                            ) : null}
                            <Text variant="labelSm" color={colors.outline} style={{ marginBottom: spacing.sm }}>
                                {destination.latitude.toFixed(5)}, {destination.longitude.toFixed(5)}
                            </Text>

                            {isDestinationRiskLoading ? (
                                <View style={styles.loadingContainer}>
                                    <ActivityIndicator size="small" color={colors.primary} />
                                    <Text variant="labelLg" color={colors['on-surface-variant']} style={{ marginTop: 8 }}>
                                        Calculating location risk from Risk Score Engine...
                                    </Text>
                                </View>
                            ) : destinationRiskError ? (
                                <View style={styles.errorBanner}>
                                    <Ionicons name="alert-circle" size={20} color={colors.error} />
                                    <Text variant="labelMd" style={{ color: colors.error, flex: 1 }}>{destinationRiskError}</Text>
                                    <TouchableOpacity style={styles.retryBtn} onPress={() => fetchDestinationRiskData(destination.latitude, destination.longitude)}>
                                        <Text variant="labelMd" style={{ color: colors.primary, fontWeight: 'bold' }}>Retry</Text>
                                    </TouchableOpacity>
                                </View>
                            ) : destinationRiskInfo ? (
                                <>
                                    {/* Risk Score & Distance Grid */}
                                    <View style={[styles.statsGrid, { marginTop: 0 }]}>
                                        <View style={[styles.statCard, { borderColor: destinationRiskInfo.colors.stroke }]}>
                                            <View style={[styles.statIconContainer, { backgroundColor: destinationRiskInfo.colors.fill }]}>
                                                <Ionicons name="shield-half-outline" size={20} color={destinationRiskInfo.colors.stroke} />
                                            </View>
                                            <View style={{ flex: 1 }}>
                                                <Text variant="labelMd" color={colors['on-surface-variant']}>Calculated Risk</Text>
                                                <Text variant="headlineSm" style={{ fontWeight: 'bold', color: destinationRiskInfo.colors.stroke }}>
                                                    {formatScore(destinationRiskInfo.score, ' / 100')}
                                                </Text>
                                                <Text variant="labelMd" style={{ fontWeight: 'bold', color: destinationRiskInfo.colors.stroke }}>
                                                    {destinationRiskInfo.label}
                                                </Text>
                                            </View>
                                        </View>

                                        <View style={styles.statCard}>
                                            <View style={styles.statIconContainer}>
                                                <Ionicons name="navigate" size={20} color={colors.primary} />
                                            </View>
                                            <View style={{ flex: 1 }}>
                                                <Text variant="labelMd" color={colors['on-surface-variant']}>Distance</Text>
                                                <Text variant="headlineSm" style={{ fontWeight: 'bold', color: colors.primary }}>
                                                    {destinationDistance !== null
                                                        ? (destinationDistance >= 1000
                                                            ? `${(destinationDistance / 1000).toFixed(2)} km`
                                                            : `${Math.round(destinationDistance)} m`)
                                                        : 'N/A'}
                                                </Text>
                                            </View>
                                        </View>
                                    </View>

                                    {/* Contributing factors (backend risk engine) */}
                                    <Text variant="labelLg" style={{ fontWeight: 'bold', marginTop: spacing.sm, marginBottom: spacing.xs, color: colors['on-surface'] }}>
                                        Contributing Factors
                                    </Text>
                                    <FactorChips risk={destinationRiskInfo.risk} />

                                    {/* High-risk cells near the destination */}
                                    <View style={[styles.detailsContainer, { marginTop: spacing.sm }]}>
                                        <View style={styles.detailRow}>
                                            <Ionicons name="alert-circle-outline" size={15} color={colors['on-surface-variant']} />
                                            <Text variant="labelMd" color={colors['on-surface-variant']}>High-risk areas nearby:</Text>
                                            <Text variant="labelMd" style={{ fontWeight: 'bold', color: (destinationRisk?.length || 0) > 0 ? colors.error : colors.primary }}>
                                                {(destinationRisk?.length || 0) > 0 ? `${destinationRisk.length} within 3km` : 'None within 3km'}
                                            </Text>
                                        </View>
                                        {destinationRisk && destinationRisk.length > 0 && (
                                            <View style={{ marginTop: 4 }}>
                                                {destinationRisk.slice(0, 2).map((z, i) => (
                                                    <Text key={i} variant="labelMd" color={colors['on-surface-variant']} style={{ marginLeft: 20 }} numberOfLines={1}>
                                                        • Cell …{String(z.h3Index || i + 1).slice(-6)}: {z.riskLevel} ({formatScore(z.totalRiskScore)})
                                                    </Text>
                                                ))}
                                            </View>
                                        )}
                                    </View>
                                </>
                            ) : null}

                            {/* Action Buttons */}
                            <View style={[styles.actionButtonsRow, { marginTop: spacing.sm }]}>
                                <TouchableOpacity 
                                    style={styles.routeBtn} 
                                    onPress={() => navigation.navigate('LiveJourney', { destination, requestId: Date.now() })}
                                >
                                    <Ionicons name="navigate-circle-outline" size={20} color={colors['on-primary']} />
                                    <Text variant="labelLg" color={colors['on-primary']} style={{ fontWeight: 'bold' }}>
                                        Route Here
                                    </Text>
                                </TouchableOpacity>

                                <TouchableOpacity style={styles.shareBtn} onPress={handleClearDestination}>
                                    <Ionicons name="close-circle-outline" size={18} color={colors.primary} />
                                    <Text variant="labelLg" color={colors.primary}>Clear</Text>
                                </TouchableOpacity>
                            </View>
                        </ScrollView>
                    </View>
                )}

                {/* The searched place, in the sheet rather than floating over the map */}
                {destination && !showDestinationPanel && !showCurrentRiskPanel && (
                    <TouchableOpacity style={styles.viewCurrentRiskChip} onPress={handleOpenDestinationDetails}>
                        <Ionicons name="location-sharp" size={18} color="#e11d48" />
                        <Text variant="labelLg" style={{ fontWeight: 'bold', flex: 1 }} numberOfLines={1}>{destination.name}</Text>
                        <Text variant="labelMd" color={colors.primary} style={{ fontWeight: 'bold' }}>View risk</Text>
                        <Ionicons name="chevron-up" size={16} color={colors['on-surface-variant']} />
                    </TouchableOpacity>
                )}

                {/* Danger Zone Fetch Error Banner */}
                {dangerZoneError && (
                    <View style={styles.errorBanner}>
                        <Ionicons name="alert-circle" size={20} color={colors.error} />
                        <Text variant="labelMd" style={{ color: colors.error, flex: 1 }}>{dangerZoneError}</Text>
                        <TouchableOpacity style={styles.retryBtn} onPress={() => loadDangerZones()}>
                            <Text variant="labelMd" style={{ color: colors.primary, fontWeight: 'bold' }}>Retry</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* Current Location / Active Zone Risk Section */}
                {!showDestinationPanel && (
                    <>
                        {/* Button chip to reveal risk panel — shown when panel is closed and not loading */}
                        {!showCurrentRiskPanel && !isCurrentRiskLoading && !destination && (
                            <TouchableOpacity
                                style={styles.viewCurrentRiskChip}
                                onPress={() => {
                                    setShowCurrentRiskPanel(true);
                                    setBottomSheetExpanded(true);
                                    // Fetch if not yet loaded
                                    if (!currentLocationRiskData && userLocation) {
                                        fetchCurrentLocationRiskData(userLocation.latitude, userLocation.longitude);
                                    }
                                }}
                            >
                                <Ionicons name="shield-half-outline" size={18} color={colors.primary} />
                                <Text variant="labelLg" style={{ fontWeight: 'bold', color: colors.primary, flex: 1 }}>
                                    View Location Risk
                                </Text>
                                <Ionicons name="chevron-up" size={16} color={colors['on-surface-variant']} />
                            </TouchableOpacity>
                        )}

                        {/* The position is only known after the first fix */}
                        {errorMessage && !userLocation && (
                            <Text variant="labelMd" color={colors['on-surface-variant']} style={{ marginBottom: spacing.xs }}>{errorMessage}</Text>
                        )}

                        {/* Loading state while fetching */}
                        {isCurrentRiskLoading && (
                            <View style={styles.loadingContainer}>
                                <ActivityIndicator size="small" color={colors.primary} />
                                <Text variant="labelLg" color={colors['on-surface-variant']} style={{ marginTop: 8 }}>
                                    Calculating current location risk score...
                                </Text>
                            </View>
                        )}

                        {/* Error state */}
                        {currentRiskError && !currentLocationRiskData && !isCurrentRiskLoading && (
                            <View style={styles.errorBanner}>
                                <Ionicons name="alert-circle" size={20} color={colors.error} />
                                <Text variant="labelMd" style={{ color: colors.error, flex: 1 }}>{currentRiskError}</Text>
                                <TouchableOpacity style={styles.retryBtn} onPress={() => userLocation && fetchCurrentLocationRiskData(userLocation.latitude, userLocation.longitude)}>
                                    <Text variant="labelMd" style={{ color: colors.primary, fontWeight: 'bold' }}>Retry</Text>
                                </TouchableOpacity>
                            </View>
                        )}

                        {/* Risk detail panel — shown only when user taps the button */}
                        {showCurrentRiskPanel && !isCurrentRiskLoading && (panelRiskInfo || activeZone) && (
                            <ScrollView style={styles.riskPanelScroll} showsVerticalScrollIndicator={false}>
                                {(() => {
                                    const activeColors = panelRiskInfo ? panelRiskInfo.colors : activeRiskColors;
                                    const displayScore = panelRiskInfo ? panelRiskInfo.score : activeZone?.totalRiskScore;
                                    const displayLevel = panelRiskInfo ? panelRiskInfo.label : (activeZone?.riskLevel || activeRiskColors.label);

                                    return (
                                        <>
                                            {/* Header with close button */}
                                            <View style={styles.sheetHeader}>
                                                <View style={{ flex: 1 }}>
                                                    <Text variant="labelMd" color={colors['on-surface-variant']} style={{ textTransform: 'uppercase', marginBottom: 2 }}>
                                                        {selectedZone ? "Selected Zone" : "Current Location Risk"}
                                                    </Text>
                                                    <Text variant="headlineMd" style={{ fontWeight: 'bold' }}>
                                                        {(selectedZone?.h3Index || currentLocationRiskData?.h3Index)
                                                            ? `Cell ${(selectedZone?.h3Index || currentLocationRiskData.h3Index).substring(0, 10)}...`
                                                            : 'Your Location'}
                                                    </Text>
                                                </View>

                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                                    <View style={[styles.riskLevelBadge, { backgroundColor: activeColors.fill, borderColor: activeColors.stroke }]}>
                                                        <View style={[styles.legendDot, { backgroundColor: activeColors.solid }]} />
                                                        <Text variant="labelLg" style={{ color: activeColors.stroke, fontWeight: 'bold' }}>
                                                            {displayLevel}
                                                        </Text>
                                                    </View>
                                                    <TouchableOpacity
                                                        onPress={clearSelectedZone}
                                                        style={{ padding: 4 }}
                                                    >
                                                        <Ionicons name="chevron-down" size={20} color={colors['on-surface-variant']} />
                                                    </TouchableOpacity>
                                                </View>
                                            </View>

                                            <View style={styles.statsGrid}>
                                                <View style={[styles.statCard, { borderColor: activeColors.stroke }]}>
                                                    <View style={[styles.statIconContainer, { backgroundColor: activeColors.fill }]}>
                                                        <Ionicons name="warning" size={22} color={activeColors.stroke} />
                                                    </View>
                                                    <View>
                                                        <Text variant="labelMd" color={colors['on-surface-variant']}>Risk Score</Text>
                                                        <Text variant="headlineSm" style={{ fontWeight: 'bold', color: activeColors.stroke }}>
                                                            {formatScore(displayScore, ' / 100')}
                                                        </Text>
                                                    </View>
                                                </View>

                                                <View style={styles.statCard}>
                                                    <View style={styles.statIconContainer}>
                                                        <Ionicons name="stats-chart" size={22} color={colors.primary} />
                                                    </View>
                                                    <View>
                                                        <Text variant="labelMd" color={colors['on-surface-variant']}>Data Confidence</Text>
                                                        <Text variant="headlineSm" style={{ fontWeight: 'bold', color: colors.primary }}>
                                                            {panelRiskData?.dataConfidence != null
                                                                ? `${Math.round(panelRiskData.dataConfidence * 100)}%`
                                                                : 'N/A'}
                                                        </Text>
                                                    </View>
                                                </View>
                                            </View>

                                            {/* Contributing factors (backend risk engine) */}
                                            {isZoneRiskLoading ? (
                                                <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: spacing.sm }} />
                                            ) : panelRiskInfo?.risk?.breakdown ? (
                                                <>
                                                    <Text variant="labelLg" style={{ fontWeight: 'bold', marginTop: spacing.xs, marginBottom: spacing.xs, color: colors['on-surface'] }}>
                                                        Contributing Factors
                                                    </Text>
                                                    <FactorChips risk={panelRiskInfo.risk} />
                                                </>
                                            ) : null}

                                        </>
                                    );
                                })()}
                            </ScrollView>
                        )}
                    </>
                )}

                {!showDestinationPanel && !showCurrentRiskPanel && (
                    <>
                        <View style={styles.quickActions}>
                            <QuickAction icon="megaphone" label="Report" primary onPress={openReport} />
                            <QuickAction icon="people" label={`Reports (${reportCount})`} onPress={() => { loadCommunityIncidents(); setShowCommunityFeed(true); }} />
                            <QuickAction icon="navigate" label="Journey" onPress={() => navigation.navigate('LiveJourney')} />
                            <QuickAction icon="share-social" label="Share" onPress={() => shareLocation(userLocation)} />
                            <QuickAction icon="options" label="Options" onPress={() => setShowMapOptions(true)} />
                        </View>

                        <View style={styles.legendRow}>
                            {LEGEND.map((item) => (
                                <View key={item.label} style={styles.legendItem}>
                                    <View style={[styles.legendDot, { backgroundColor: item.color }]} />
                                    <Text variant="labelSm" color={colors['on-surface-variant']}>{item.label}</Text>
                                </View>
                            ))}
                        </View>

                        {mapNotice && (
                            <Text variant="labelSm" color={colors['on-surface-variant']} style={{ textAlign: 'center', marginTop: spacing.xs }}>
                                {mapNotice}
                            </Text>
                        )}
                    </>
                )}
            </View>
            )}

            {/* Everything that used to float over the map */}
            <Modal visible={showMapOptions} transparent animationType="slide" onRequestClose={() => setShowMapOptions(false)}>
                <TouchableOpacity style={styles.placeBackdrop} activeOpacity={1} onPress={() => setShowMapOptions(false)}>
                    <TouchableOpacity style={styles.placeSheet} activeOpacity={1}>
                        <View style={styles.sheetHeader}>
                            <Text variant="headlineSm" style={{ fontWeight: 'bold' }}>Map options</Text>
                            <TouchableOpacity onPress={() => setShowMapOptions(false)} accessibilityLabel="Close">
                                <Ionicons name="close" size={24} color={colors['on-surface-variant']} />
                            </TouchableOpacity>
                        </View>

                        <Text variant="labelLg" style={styles.optionTitle}>Map style</Text>
                        <View style={styles.optionRow}>
                            {[{ key: 'standard', label: 'Standard' }, { key: 'hybrid', label: 'Satellite' }].map((option) => {
                                const on = mapType === option.key;
                                return (
                                    <TouchableOpacity
                                        key={option.key}
                                        onPress={() => setMapType(option.key)}
                                        style={[styles.nearbyChip, on && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                                    >
                                        <Text variant="labelMd" style={{ color: on ? '#fff' : colors['on-surface'], fontWeight: '700' }}>{option.label}</Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </View>

                        <Text variant="labelLg" style={styles.optionTitle}>Show nearby places</Text>
                        <View style={styles.optionRow}>
                            {NEARBY_TYPES.map((t) => {
                                const on = visibleTypes.has(t.key);
                                return (
                                    <TouchableOpacity
                                        key={t.key}
                                        onPress={() => toggleType(t.key)}
                                        style={[styles.nearbyChip, on && { backgroundColor: t.color, borderColor: t.color }]}
                                        accessibilityLabel={`${on ? 'Hide' : 'Show'} ${t.label}`}
                                    >
                                        <Ionicons name={t.icon} size={14} color={on ? '#fff' : t.color} />
                                        <Text variant="labelMd" style={{ color: on ? '#fff' : colors['on-surface'], fontWeight: '700' }}>{t.label}</Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </View>
                        <Text variant="labelSm" color={colors['on-surface-variant']} style={{ marginTop: 6 }}>
                            Zoom in to see the pins.{nearby && nearbyStatusText(nearby) ? ` ${nearbyStatusText(nearby)}` : ''}
                        </Text>

                        <Text variant="labelLg" style={styles.optionTitle}>Data</Text>
                        <View style={styles.optionRow}>
                            <TouchableOpacity style={styles.nearbyChip} onPress={() => { loadDangerZones(); loadCommunityIncidents(); setShowMapOptions(false); }}>
                                <Ionicons name="refresh" size={14} color={colors.primary} />
                                <Text variant="labelMd" style={{ fontWeight: '700', color: colors['on-surface'] }}>Refresh map</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.nearbyChip} onPress={() => { setShowMapOptions(false); setShowStatusModal(true); }}>
                                <Ionicons name={trackingActive ? 'radio' : 'warning'} size={14} color={trackingActive ? 'green' : colors.error} />
                                <Text variant="labelMd" style={{ fontWeight: '700', color: colors['on-surface'] }}>{trackingActive ? 'Live tracking on' : 'GPS required'}</Text>
                            </TouchableOpacity>
                        </View>
                    </TouchableOpacity>
                </TouchableOpacity>
            </Modal>

            {/* Tapped nearby place: name, distance, Call (only with a phone number) and Directions */}
            <Modal visible={Boolean(selectedPlace)} transparent animationType="slide" onRequestClose={() => setSelectedPlace(null)}>
                <TouchableOpacity style={styles.placeBackdrop} activeOpacity={1} onPress={() => setSelectedPlace(null)}>
                    {selectedPlace && (
                        <View style={styles.placeSheet}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                                <View style={[styles.placeIcon, { backgroundColor: `${typeMeta(selectedPlace.type).color}22` }]}>
                                    <Ionicons name={typeMeta(selectedPlace.type).icon} size={22} color={typeMeta(selectedPlace.type).color} />
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text variant="headlineSm" style={{ fontWeight: 'bold' }} numberOfLines={2}>
                                        {selectedPlace.name || `${selectedPlace.typeLabel} (name unknown)`}
                                    </Text>
                                    <Text variant="labelMd" color={colors['on-surface-variant']}>
                                        {formatDistance(selectedPlace.distance)} away · {typeMeta(selectedPlace.type).label}
                                    </Text>
                                </View>
                                <OpenChip openNow={selectedPlace.openNow} />
                            </View>
                            {selectedPlace.address ? (
                                <Text variant="bodyMd" color={colors['on-surface-variant']} style={{ marginTop: 10 }}>{selectedPlace.address}</Text>
                            ) : null}
                            {selectedPlace.openingHours ? (
                                <Text variant="labelMd" color={colors['on-surface-variant']} style={{ marginTop: 4 }}>Hours: {selectedPlace.openingHours}</Text>
                            ) : null}
                            <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}>
                                {sanitizePhone(selectedPlace.phone) ? (
                                    <TouchableOpacity style={[styles.placeBtn, { backgroundColor: '#1b8a3a' }]} onPress={() => callNumber(selectedPlace.phone)}>
                                        <Ionicons name="call" size={18} color="#fff" />
                                        <Text variant="labelLg" style={{ color: '#fff', fontWeight: 'bold' }}>Call</Text>
                                    </TouchableOpacity>
                                ) : null}
                                <TouchableOpacity
                                    style={[styles.placeBtn, { backgroundColor: colors.primary }]}
                                    onPress={() => openDirections({ lat: selectedPlace.lat, lng: selectedPlace.lng, name: selectedPlace.name || selectedPlace.typeLabel })}
                                >
                                    <Ionicons name="navigate" size={18} color="#fff" />
                                    <Text variant="labelLg" style={{ color: '#fff', fontWeight: 'bold' }}>Directions</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    )}
                </TouchableOpacity>
            </Modal>

            {/* Location Status Diagnostics Modal */}
            <LocationStatusModal
                visible={showStatusModal}
                onClose={() => setShowStatusModal(false)}
                userLocation={userLocation}
                accuracy={locationAccuracy}
                trackingActive={trackingActive}
                currentZone={currentLocationRiskData}
                permissionStatus={permissionStatus}
                lastUpdateTime={lastUpdateTime}
                offlineQueueSize={locationService.getOfflineQueueSize()}
            />

            {/* Report Community Incident Modal */}
            <Modal visible={showReportModal} transparent animationType="slide" onRequestClose={() => setShowReportModal(false)}>
                <KeyboardAvoidingView style={styles.permissionOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                    <View style={styles.permissionCard}>
                        <View style={styles.sheetHeader}>
                            <Text variant="headlineSm" style={{ fontWeight: 'bold', color: colors.primary }}>
                                Report an incident
                            </Text>
                            <TouchableOpacity onPress={() => setShowReportModal(false)}>
                                <Ionicons name="close" size={24} color={colors['on-surface-variant']} />
                            </TouchableOpacity>
                        </View>

                        {incidentMessage && (
                            <View style={styles.errorBanner}>
                                <Text variant="labelMd" style={{ color: colors.error }}>{incidentMessage}</Text>
                            </View>
                        )}

                        <Text variant="labelMd" color={colors['on-surface-variant']} style={{ alignSelf: 'flex-start', marginBottom: spacing.sm }}>
                            {userLocation ? 'This is filed at your current location and raises the risk score for this area.' : 'Your location is needed to file a report. Waiting for GPS.'}
                        </Text>
                        <Text variant="labelLg" style={{ alignSelf: 'flex-start', marginBottom: 6 }}>What happened?</Text>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.md, maxHeight: 44 }}>
                            {reportCategories.map(cat => (
                                <TouchableOpacity 
                                    key={cat} 
                                    style={[
                                        styles.statusChip, 
                                        selectedIncidentType === cat && { backgroundColor: colors.primary }
                                    ]}
                                    onPress={() => setSelectedIncidentType(cat)}
                                >
                                    <Text variant="labelMd" style={{ color: selectedIncidentType === cat ? colors.white : colors['on-surface'] }}>
                                        {cat}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </ScrollView>

                        <Text variant="labelLg" style={{ alignSelf: 'flex-start', marginBottom: 6 }}>Description</Text>
                        <TextInput 
                            style={styles.communityInput}
                            placeholder="Describe the incident (min 5 chars)..."
                            placeholderTextColor={colors['on-surface-variant']}
                            value={incidentDescription}
                            onChangeText={setIncidentDescription}
                            multiline
                            numberOfLines={3}
                        />

                        <TouchableOpacity 
                            style={styles.permissionButton} 
                            onPress={handleReportIncidentSubmit}
                            disabled={isSubmittingIncident}
                        >
                            {isSubmittingIncident ? (
                                <ActivityIndicator size="small" color={colors.white} />
                            ) : (
                                <Text variant="labelLg" color={colors.white} style={{ fontWeight: 'bold' }}>
                                    Submit report
                                </Text>
                            )}
                        </TouchableOpacity>
                    </View>
                </KeyboardAvoidingView>
            </Modal>

            {/* Community Incidents Feed Modal */}
            <Modal visible={showCommunityFeed} transparent animationType="slide" onRequestClose={() => setShowCommunityFeed(false)}>
                <View style={styles.permissionOverlay}>
                    <View style={[styles.permissionCard, { maxHeight: '80%' }]}>
                        <View style={styles.sheetHeader}>
                            <Text variant="headlineSm" style={{ fontWeight: 'bold', color: colors.primary }}>
                                Reports nearby ({reportCount})
                            </Text>
                            <TouchableOpacity onPress={() => setShowCommunityFeed(false)}>
                                <Ionicons name="close" size={24} color={colors['on-surface-variant']} />
                            </TouchableOpacity>
                        </View>

                        {isLoadingCommunity ? (
                            <View style={styles.communityState}>
                                <ActivityIndicator size="large" color={colors.primary} />
                            </View>
                        ) : communityError ? (
                            <View style={styles.communityState}>
                                <Text variant="bodyMd" color={colors.error} style={{ textAlign: 'center' }}>{communityError}</Text>
                                <TouchableOpacity style={styles.communityRetryButton} onPress={() => loadCommunityIncidents()}>
                                    <Text variant="labelMd" color={colors.white}>Try Again</Text>
                                </TouchableOpacity>
                            </View>
                        ) : allReports.length === 0 ? (
                            <Text variant="bodyMd" color={colors['on-surface-variant']} style={{ textAlign: 'center', marginVertical: spacing.xl }}>
                                No incidents reported nearby.
                            </Text>
                        ) : (
                            <ScrollView contentContainerStyle={{ gap: spacing.md, paddingVertical: spacing.sm }}>
                                {allReports.map(inc => (
                                    <View key={inc._id || inc.id} style={styles.communityCard}>
                                        <View style={styles.sheetHeader}>
                                            <Text variant="labelLg" style={{ fontWeight: 'bold', color: colors.primary }}>
                                                {inc.incidentType || 'Incident'}
                                            </Text>
                                            <Text variant="labelSm" color={colors.outline}>
                                                {new Date(inc.createdAt || Date.now()).toLocaleTimeString()}
                                            </Text>
                                        </View>
                                        <Text variant="bodyMd" style={{ marginBottom: 8 }}>{inc.description}</Text>
                                        {inc.queued ? (
                                            <Text variant="labelMd" color={colors['on-surface-variant']}>Saved on this phone. It uploads when you are back online.</Text>
                                        ) : (
                                        <View style={styles.votingRow}>
                                            <TouchableOpacity 
                                                style={styles.voteBtn}
                                                onPress={() => handleConfirmIncident(inc._id || inc.id)}
                                            >
                                                <Ionicons name="thumbs-up-outline" size={16} color="green" />
                                                <Text variant="labelMd" style={{ color: 'green', fontWeight: 'bold' }}>
                                                    Confirm ({inc.confirmationCount ?? 0})
                                                </Text>
                                            </TouchableOpacity>

                                            <TouchableOpacity 
                                                style={styles.voteBtn}
                                                onPress={() => handleReportFalse(inc._id || inc.id)}
                                            >
                                                <Ionicons name="thumbs-down-outline" size={16} color={colors.error} />
                                                <Text variant="labelMd" style={{ color: colors.error, fontWeight: 'bold' }}>
                                                    False Report ({inc.falseReportCount ?? 0})
                                                </Text>
                                            </TouchableOpacity>
                                        </View>
                                        )}
                                    </View>
                                ))}
                            </ScrollView>
                        )}

                        <TouchableOpacity
                            style={styles.permissionButton}
                            onPress={() => {
                                setShowCommunityFeed(false);
                                openReport();
                            }}
                        >
                            <Text variant="labelLg" color={colors.white} style={{ fontWeight: 'bold' }}>Report an incident</Text>
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
    topSearchContainer: {
        position: 'absolute',
        top: spacing.xl + 20,
        left: spacing.md,
        right: spacing.md,
        zIndex: 10,
        // Cap total height so nothing overflows below the bottom sheet
        maxHeight: height * 0.55,
    },
    searchHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginBottom: spacing.xs,
    },
    menuButton: {
        width: 48,
        height: 48,
        borderRadius: 24,
        backgroundColor: 'rgba(255, 255, 255, 0.97)',
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.1,
        shadowRadius: 8,
        elevation: 5,
        borderWidth: 1,
        borderColor: 'rgba(217, 194, 183, 0.3)',
        flexShrink: 0,
    },
    nearbyChip: {
        flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5,
        borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.95)', borderWidth: 1, borderColor: 'rgba(0,0,0,0.12)',
    },
    placeBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
    placeSheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 32 },
    placeIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    placeBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: 14 },
    searchBar: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.97)',
        borderRadius: shapes.roundedPill,
        paddingHorizontal: spacing.md,
        height: 48,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.1,
        shadowRadius: 8,
        elevation: 5,
        borderWidth: 1,
        borderColor: 'rgba(217, 194, 183, 0.3)',
    },
    searchInput: {
        flex: 1,
        marginLeft: spacing.sm,
        fontSize: typography.sizes.bodyMd || 14,
        color: colors['on-surface'],
        height: 48,
    },
    micButton: {
        padding: 6,
    },
    statusChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: 'rgba(255, 255, 255, 0.95)',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: shapes.roundedPill,
        borderWidth: 1,
        borderColor: 'rgba(217, 194, 183, 0.3)',
    },
    geofenceToastBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        backgroundColor: colors.primary,
        paddingHorizontal: spacing.md,
        paddingVertical: 10,
        borderRadius: shapes.roundedPill,
        marginTop: spacing.sm,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 8,
        elevation: 6,
    },
    fabSmall: {
        width: 48,
        height: 48,
        borderRadius: 16,
        backgroundColor: colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.1,
        shadowRadius: 8,
        elevation: 4,
        borderWidth: 1,
        borderColor: 'rgba(217, 194, 183, 0.3)',
    },
    legendItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    legendDot: {
        width: 12,
        height: 12,
        borderRadius: 6,
    },
    fabColumn: {
        position: 'absolute',
        right: spacing.md,
        alignItems: 'center',
        gap: spacing.sm,
        zIndex: 20,
    },
    sosFab: {
        width: 52,
        height: 52,
        borderRadius: 26,
        backgroundColor: colors.error,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: colors.error,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.4,
        shadowRadius: 10,
        elevation: 8,
    },
    quickActions: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: spacing.sm,
    },
    quickAction: {
        flex: 1,
        alignItems: 'center',
        gap: 4,
    },
    quickIcon: {
        width: 46,
        height: 46,
        borderRadius: 23,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors['surface-container-high'],
    },
    legendRow: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: spacing.md,
        marginTop: spacing.md,
    },
    riskPanelScroll: {
        maxHeight: height * 0.45,
    },
    optionTitle: {
        fontWeight: 'bold',
        marginTop: spacing.md,
        marginBottom: 6,
    },
    optionRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    bottomSheet: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: colors.surface,
        borderTopLeftRadius: 32,
        borderTopRightRadius: 32,
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.xs,
        paddingBottom: spacing.lg,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -10 },
        shadowOpacity: 0.1,
        shadowRadius: 20,
        elevation: 15,
        zIndex: 30,
    },
    sheetHandleContainer: {
        alignItems: 'center',
        paddingVertical: spacing.sm,
    },
    sheetHandle: {
        width: 48,
        height: 6,
        backgroundColor: 'rgba(217, 194, 183, 0.4)',
        borderRadius: 3,
    },
    sheetHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: spacing.md,
    },
    riskLevelBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: shapes.roundedPill,
        borderWidth: 1,
    },
    statsGrid: {
        flexDirection: 'row',
        gap: spacing.md,
        marginBottom: spacing.md,
    },
    statCard: {
        flex: 1,
        backgroundColor: colors['surface-container-low'],
        padding: spacing.md,
        borderRadius: shapes.roundedLg,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        borderWidth: 1,
        borderColor: 'rgba(217, 194, 183, 0.2)',
    },
    statIconContainer: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(182, 115, 73, 0.1)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    detailsContainer: {
        backgroundColor: colors['surface-container-low'],
        borderRadius: shapes.roundedLg,
        padding: spacing.md,
        gap: spacing.sm,
        borderWidth: 1,
        borderColor: 'rgba(217, 194, 183, 0.2)',
    },
    detailRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    loadingContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.xl,
    },
    errorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        backgroundColor: colors['error-container'] || '#ffdad6',
        padding: spacing.sm + 2,
        borderRadius: shapes.roundedSm,
        marginBottom: spacing.sm,
    },
    retryBtn: {
        paddingHorizontal: spacing.sm,
        paddingVertical: 4,
    },
    actionButtonsRow: {
        flexDirection: 'row',
        gap: spacing.md,
    },
    routeBtn: {
        flex: 1,
        height: 56,
        backgroundColor: colors.primary,
        borderRadius: shapes.roundedPill,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    shareBtn: {
        flex: 1,
        height: 56,
        backgroundColor: colors['surface-container-high'],
        borderRadius: shapes.roundedPill,
        borderWidth: 1,
        borderColor: 'rgba(113, 85, 72, 0.2)',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    permissionOverlay: {
        ...StyleSheet.absoluteFill,
        backgroundColor: 'rgba(33, 26, 22, 0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing.lg,
        zIndex: 50,
    },
    permissionCard: {
        backgroundColor: colors.surface,
        borderRadius: shapes.roundedLg,
        padding: spacing.lg,
        alignItems: 'center',
        width: '100%',
        maxWidth: 340,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.25,
        shadowRadius: 15,
        elevation: 10,
        borderWidth: 1,
        borderColor: 'rgba(217, 194, 183, 0.3)',
    },
    permissionIconContainer: {
        width: 64,
        height: 64,
        borderRadius: 32,
        backgroundColor: 'rgba(182, 115, 73, 0.1)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: spacing.md,
    },
    permissionTitle: {
        fontWeight: 'bold',
        textAlign: 'center',
        marginBottom: spacing.sm,
        color: colors.primary,
    },
    permissionMessage: {
        textAlign: 'center',
        marginBottom: spacing.lg,
        lineHeight: 20,
    },
    permissionButton: {
        backgroundColor: colors.primary,
        borderRadius: shapes.roundedPill,
        paddingVertical: 12,
        paddingHorizontal: 24,
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
    },
    communityInput: {
        borderWidth: 1,
        borderColor: colors.outline,
        borderRadius: shapes.roundedSm,
        padding: spacing.md,
        fontSize: typography.sizes.bodyLg,
        color: colors['on-surface'],
        width: '100%',
        marginBottom: spacing.lg,
        minHeight: 80,
        textAlignVertical: 'top',
    },
    communityCard: {
        backgroundColor: colors['surface-container-low'],
        padding: spacing.md,
        borderRadius: shapes.roundedLg,
        borderWidth: 1,
        borderColor: 'rgba(217, 194, 183, 0.2)',
        width: '100%',
    },
    communityState: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.md,
        paddingVertical: spacing.xl,
    },
    communityRetryButton: {
        backgroundColor: colors.primary,
        borderRadius: shapes.roundedPill,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
    },
    votingRow: {
        flexDirection: 'row',
        gap: spacing.md,
        marginTop: spacing.sm,
    },
    voteBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: shapes.roundedPill,
        backgroundColor: colors['surface-container'],
    },
    // Autocomplete & Destination Search Styles
    autocompleteDropdown: {
        backgroundColor: colors.surface,
        borderRadius: shapes.roundedLg,
        marginTop: spacing.xs,
        paddingVertical: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 10,
        elevation: 6,
        borderWidth: 1,
        borderColor: 'rgba(217, 194, 183, 0.3)',
        overflow: 'hidden',
    },
    autocompleteItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.md,
        paddingVertical: 10,
        borderBottomWidth: 0.5,
        borderBottomColor: 'rgba(217, 194, 183, 0.2)',
        gap: spacing.sm,
    },
    searchErrorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        backgroundColor: '#fee2e2',
        paddingHorizontal: spacing.md,
        paddingVertical: 8,
        borderRadius: shapes.roundedPill,
        marginTop: spacing.xs,
        borderWidth: 1,
        borderColor: '#fca5a5',
    },
    destinationCard: {
        backgroundColor: colors['surface-container-low'],
        borderRadius: shapes.roundedLg,
        padding: spacing.md,
        marginBottom: spacing.md,
        borderWidth: 1.5,
        borderColor: colors.primary,
        maxHeight: height * 0.42,
    },
    destinationCardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: spacing.xs,
    },
    destinationCardBody: {
        flexShrink: 1,
    },
    clearDestBtn: {
        padding: 4,
    },
    factorGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        marginVertical: spacing.xs,
    },
    factorChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: colors['surface-container-low'],
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: shapes.roundedPill,
        borderWidth: 1,
        borderColor: 'rgba(217, 194, 183, 0.3)',
    },
    viewCurrentRiskChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        backgroundColor: colors['surface-container-low'],
        paddingHorizontal: spacing.md,
        paddingVertical: 12,
        borderRadius: shapes.roundedLg,
        borderWidth: 1.5,
        borderColor: colors.primary,
        marginBottom: spacing.xs,
    },
});
