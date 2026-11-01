import React, { useEffect, useState } from 'react';
import { View, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/Screen';
import { Text } from '../../components/Text';
import { DataState } from '../../components/DataState';
import { journeyService } from '../../services/journeys';

import { colors, spacing, shapes } from '../../theme/theme';

const STATUS_ICON = {
  ACTIVE: { name: 'navigate-circle', color: colors.primary },
  COMPLETED: { name: 'checkmark-circle', color: colors.tertiary },
  CANCELLED: { name: 'close-circle', color: colors.outline },
};

const destinationLabel = (item) => {
  if (item.metadata?.destinationName) return item.metadata.destinationName;
  const [lng, lat] = item.destination?.coordinates || [];
  return Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : 'Unknown destination';
};

export const JourneyHistoryScreen = ({ navigation }) => {

  const [items, setItems] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    setItems(null);
    const res = await journeyService.list();
    if (res.success) {
      setItems(res.journeys);
    } else {
      setError(res.error?.message || 'Failed to load journey history.');
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <Screen style={styles.container}>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 }}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Ionicons name="arrow-back" size={24} color={colors.primary} />
          </TouchableOpacity>

          <Text variant="headlineMd" style={styles.title}>Journey History</Text>
        </View>
        <View style={{ width: 24 }} />
      </View>

      {!items ? (
        <DataState loading={!error} error={error} onRetry={load} />
      ) : items.length === 0 ? (
        <DataState empty emptyText="No journeys yet. Your active and finished journeys will appear here." />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {items.map((item, index) => {
            const isActive = item.status === 'ACTIVE';
            const icon = STATUS_ICON[item.status] || STATUS_ICON.ACTIVE;
            return (
              <TouchableOpacity
                key={item._id || item.id || `journey-${index}`}
                style={styles.card}
                onPress={() => navigation.navigate('LiveJourney')}
                disabled={!isActive}
              >
                <Ionicons name={icon.name} size={28} color={icon.color} />
                <View style={{ flex: 1 }}>
                  <Text variant="labelLg" style={{ fontWeight: 'bold' }} numberOfLines={1}>
                    {destinationLabel(item)}
                  </Text>
                  <Text color={colors['on-surface-variant']}>
                    {item.status}{item.metadata?.arrived ? ' · arrived' : ''}
                  </Text>
                  {item.startTime && (
                    <Text variant="labelMd" color={colors.outline}>
                      Started: {new Date(item.startTime).toLocaleString()}
                    </Text>
                  )}
                  {item.endTime ? (
                    <Text variant="labelMd" color={colors.outline}>
                      Ended: {new Date(item.endTime).toLocaleString()}
                    </Text>
                  ) : item.expectedArrivalTime ? (
                    <Text variant="labelMd" color={colors.outline}>
                      ETA: {new Date(item.expectedArrivalTime).toLocaleString()}
                    </Text>
                  ) : null}
                </View>
                {isActive && <Ionicons name="chevron-forward" size={20} color={colors.outline} />}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </Screen>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  header: {
    padding: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderColor: colors['surface-variant'],
  },
  title: {
    fontWeight: 'bold',
    color: colors.primary,
    flexShrink: 1,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors['surface-container-low'],
    borderRadius: shapes.roundedLg,
    borderWidth: 1,
    borderColor: colors['surface-variant'],
  },
});
