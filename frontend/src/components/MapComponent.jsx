import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import { colors } from '../theme/theme';
import { Text } from './Text';
import { NEARBY_TYPES } from '../services/nearby';
import { buildMapHtml } from '../map/mapHtml';

const PALETTE = {
    SAFE: { fill: 'rgba(34, 197, 94, 0.3)', stroke: '#15803d', solid: '#22c55e', label: 'Safe' },
    LOW: { fill: 'rgba(250, 204, 21, 0.35)', stroke: '#ca8a04', solid: '#facc15', label: 'Low Risk' },
    MODERATE: { fill: 'rgba(249, 115, 22, 0.4)', stroke: '#c2410c', solid: '#f97316', label: 'Moderate Risk' },
    HIGH: { fill: 'rgba(225, 29, 72, 0.45)', stroke: '#be123c', solid: colors.error || '#e11d48', label: 'High Risk' },
    EXTREME: { fill: 'rgba(186, 26, 26, 0.55)', stroke: '#7f1d1d', solid: '#991b1b', label: 'Extreme Risk' },
    UNKNOWN: { fill: 'rgba(148, 163, 184, 0.25)', stroke: '#64748b', solid: '#94a3b8', label: 'Not enough data' },
};

/**
 * Colours for a backend risk level (SAFE | LOW | MODERATE | HIGH | EXTREME | UNKNOWN).
 * A missing/unrecognised level is UNKNOWN, never SAFE.
 */
export const getRiskColors = (riskLevel) => {
    const level = String(riskLevel || '').toUpperCase();
    return PALETTE[level] || PALETTE.UNKNOWN;
};

const MAP_HTML = buildMapHtml();

const zoneKey = (zone, index) => zone._id || zone.hotspotId || zone.h3Index || `zone-${index}`;

const zoneCenter = (zone) => {
    if (zone.location && Array.isArray(zone.location.coordinates)) {
        return { latitude: Number(zone.location.coordinates[1]), longitude: Number(zone.location.coordinates[0]) };
    }
    if (zone.latitude !== undefined && zone.longitude !== undefined) {
        return { latitude: Number(zone.latitude), longitude: Number(zone.longitude) };
    }
    if (zone.lat !== undefined && zone.lng !== undefined) {
        return { latitude: Number(zone.lat), longitude: Number(zone.lng) };
    }
    return null;
};

const toPageZones = (dangerZones) => dangerZones.flatMap((zone, index) => {
    const center = zoneCenter(zone);
    if (!center || !Number.isFinite(center.latitude) || !Number.isFinite(center.longitude)) return [];
    const riskColors = getRiskColors(zone.riskLevel);
    const alpha = Number((riskColors.fill.match(/([\d.]+)\)$/) || [])[1]);
    return [{
        id: zoneKey(zone, index),
        latitude: center.latitude,
        longitude: center.longitude,
        polygon: Array.isArray(zone.polygon)
            ? zone.polygon.map((pt) => (Array.isArray(pt)
                ? { latitude: pt[0], longitude: pt[1] }
                : { latitude: pt.latitude ?? pt.lat, longitude: pt.longitude ?? pt.lng }))
            : null,
        radius: zone.radius || 200,
        fill: riskColors.solid,
        fillOpacity: Number.isFinite(alpha) ? alpha : 0.3,
        stroke: riskColors.stroke,
    }];
});

const toPagePlaces = (nearbyPlaces) => nearbyPlaces.map((place) => ({
    id: place.id,
    latitude: place.lat,
    longitude: place.lng,
    color: (NEARBY_TYPES.find((t) => t.key === place.type) || {}).color,
}));

// Community reports stay visually separate from the risk cells.
const toPageIncidents = (communityIncidents) => communityIncidents.flatMap((incident) => {
    const latitude = Number(incident.latitude ?? incident.location?.coordinates?.[1]);
    const longitude = Number(incident.longitude ?? incident.location?.coordinates?.[0]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    return [{
        latitude,
        longitude,
        title: incident.incidentType || 'Community incident',
        description: incident.description || 'Reported by the community',
        color: incident.severity === 'CRITICAL' || incident.severity === 'HIGH' ? colors.error : '#f97316',
    }];
});

/** Stops a missing native WebView (an old development build) from taking the whole app down with it. */
class MapErrorBoundary extends React.Component {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    render() {
        if (!this.state.failed) return this.props.children;
        return (
            <View style={styles.fallback}>
                <Text variant="headlineSm" style={{ fontWeight: 'bold', marginBottom: 6, textAlign: 'center' }}>Map could not start</Text>
                <Text variant="bodyMd" color={colors['on-surface-variant']} style={{ textAlign: 'center' }}>
                    This build does not include the map component. Open the app in Expo Go or install a new development build.
                </Text>
            </View>
        );
    }
}

const NativeSurface = forwardRef(({ onMessage }, ref) => {
    const { WebView } = require('react-native-webview');
    return (
        <WebView
            ref={ref}
            style={styles.map}
            // A base URL gives tile requests a Referer, which OpenStreetMap's servers require.
            source={{ html: MAP_HTML, baseUrl: 'https://safetours.app.local/' }}
            originWhitelist={['*']}
            onMessage={(e) => onMessage(e.nativeEvent.data)}
            javaScriptEnabled
            domStorageEnabled
            cacheEnabled
            // Tiles already seen stay available with a weak or absent connection.
            cacheMode="LOAD_CACHE_ELSE_NETWORK"
            setSupportMultipleWindows={false}
            scrollEnabled={false}
            overScrollMode="never"
            androidLayerType="hardware"
        />
    );
});
NativeSurface.displayName = 'NativeSurface';

const WebSurface = forwardRef(({ onMessage }, ref) => {
    const frame = useRef(null);
    useImperativeHandle(ref, () => ({
        postMessage: (text) => frame.current?.contentWindow?.postMessage(text, '*'),
    }));
    useEffect(() => {
        const listener = (e) => {
            if (e.source === frame.current?.contentWindow && typeof e.data === 'string') onMessage(e.data);
        };
        window.addEventListener('message', listener);
        return () => window.removeEventListener('message', listener);
    }, [onMessage]);
    return React.createElement('iframe', {
        ref: frame,
        srcDoc: MAP_HTML,
        title: 'Safety map',
        style: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 },
    });
});
WebSurface.displayName = 'WebSurface';

export const MapComponent = forwardRef(({
    region,
    onRegionChangeComplete,
    userLocation,
    mapType = 'standard',
    dangerZones = [],
    communityIncidents = [],
    selectedZone = null,
    onSelectZone,
    nearbyPlaces = [],
    onSelectPlace = null,
    destinationMarker = null,
    onSelectDestination = null,
    route = null,
    bottomInset = 0,
    onTilesStatus = null,
}, ref) => {
    const surface = useRef(null);
    const ready = useRef(false);
    const queue = useRef([]);
    const cameraPlaced = useRef(false);
    const latest = useRef({});
    latest.current = { dangerZones, nearbyPlaces, onSelectZone, onSelectPlace, onSelectDestination, destinationMarker, onRegionChangeComplete, onTilesStatus };

    const send = useCallback((msg) => {
        if (!ready.current || !surface.current) {
            queue.current.push(msg);
            return;
        }
        if (Platform.OS === 'web') {
            surface.current.postMessage(JSON.stringify(msg));
        } else {
            surface.current.injectJavaScript(`window.SafeToursMap && window.SafeToursMap.receive(${JSON.stringify(msg)}); true;`);
        }
    }, []);

    useImperativeHandle(ref, () => ({
        animateToRegion: (target, ms = 800) => send({ type: 'camera', region: target, ms }),
    }), [send]);

    const handleMessage = useCallback((text) => {
        let msg;
        try {
            msg = JSON.parse(text);
        } catch (e) {
            return;
        }
        const cb = latest.current;
        if (msg.type === 'ready') {
            ready.current = true;
            const pending = queue.current;
            queue.current = [];
            pending.forEach(send);
        } else if (msg.type === 'zone') {
            const zone = cb.dangerZones.find((z, i) => zoneKey(z, i) === msg.id);
            if (zone && cb.onSelectZone) cb.onSelectZone(zone);
        } else if (msg.type === 'place') {
            const place = cb.nearbyPlaces.find((p) => p.id === msg.id);
            if (place && cb.onSelectPlace) cb.onSelectPlace(place);
        } else if (msg.type === 'destination') {
            if (cb.onSelectDestination) cb.onSelectDestination(cb.destinationMarker);
        } else if (msg.type === 'region') {
            if (cb.onRegionChangeComplete) cb.onRegionChangeComplete(msg.region);
        } else if (msg.type === 'tiles') {
            if (cb.onTilesStatus) cb.onTilesStatus(msg.status);
        }
    }, [send]);

    // `region` only places the first camera, like a native map's initialRegion. Later moves use animateToRegion.
    useEffect(() => {
        if (!region || cameraPlaced.current) return;
        cameraPlaced.current = true;
        send({ type: 'camera', region });
    }, [region, send]);

    const pageZones = useMemo(() => toPageZones(dangerZones), [dangerZones]);
    const pagePlaces = useMemo(() => toPagePlaces(nearbyPlaces), [nearbyPlaces]);
    const pageIncidents = useMemo(() => toPageIncidents(communityIncidents), [communityIncidents]);
    const selectedId = selectedZone ? (selectedZone._id || selectedZone.hotspotId || selectedZone.h3Index || null) : null;
    const hasDestination = Number.isFinite(destinationMarker?.latitude) && Number.isFinite(destinationMarker?.longitude);

    // The page is told what changed, so one moving GPS dot never redraws every hexagon.
    useEffect(() => { send({ type: 'data', zones: pageZones, selectedId }); }, [pageZones]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { send({ type: 'select', id: selectedId }); }, [selectedId, send]);
    useEffect(() => { send({ type: 'data', places: pagePlaces }); }, [pagePlaces, send]);
    useEffect(() => { send({ type: 'data', incidents: pageIncidents }); }, [pageIncidents, send]);
    useEffect(() => {
        send({ type: 'data', destination: hasDestination ? { latitude: destinationMarker.latitude, longitude: destinationMarker.longitude } : null });
    }, [hasDestination, destinationMarker?.latitude, destinationMarker?.longitude, send]);
    useEffect(() => { send({ type: 'data', route: route || null }); }, [route, send]);
    useEffect(() => {
        send({ type: 'data', user: userLocation ? { latitude: userLocation.latitude, longitude: userLocation.longitude } : null, userColor: colors.primary });
    }, [userLocation?.latitude, userLocation?.longitude, send]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { send({ type: 'mapType', mapType }); }, [mapType, send]);
    useEffect(() => { send({ type: 'inset', bottom: bottomInset }); }, [bottomInset, send]);

    const Surface = Platform.OS === 'web' ? WebSurface : NativeSurface;

    return (
        <View style={styles.map}>
            <MapErrorBoundary>
                <Surface ref={surface} onMessage={handleMessage} />
            </MapErrorBoundary>
        </View>
    );
});

MapComponent.displayName = 'MapComponent';

const styles = StyleSheet.create({
    map: {
        ...StyleSheet.absoluteFillObject,
    },
    fallback: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: colors['surface-container'],
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
    },
});
