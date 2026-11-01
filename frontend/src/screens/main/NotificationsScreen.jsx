import React, { useState, useEffect, useCallback } from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { Screen } from '../../components/Screen';
import { Text } from '../../components/Text';
import { DataState } from '../../components/DataState';
import { colors, spacing, shapes } from '../../theme/theme';
import { Ionicons } from '@expo/vector-icons';
import { notificationService } from '../../services/notifications';
import { formatApiError } from '../../services/apiClient';
import { useSidebar } from '../../context/SidebarContext';

export const NotificationsScreen = ({ navigation }) => {
  const { toggleDrawer } = useSidebar();
  const [activeFilter, setActiveFilter] = useState('All');
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const filters = ['All', 'SOS Alerts', 'Travel Updates', 'System'];

  const fetchNotifications = useCallback(async () => {
    setError('');
    try {
      const data = await notificationService.list();
      setNotifications(data || []);
    } catch (err) {
      const formatted = formatApiError(err);
      setError(formatted.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // The real Expo push token is registered after login by SafetyCheckProvider (services/pushNotifications.js).
    fetchNotifications();
  }, [fetchNotifications]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchNotifications();
  };

  const typeOf = (n) => String(n.type || '').toUpperCase();

  const getFilteredNotifications = () => {
    if (activeFilter === 'All') return notifications;
    if (activeFilter === 'SOS Alerts') {
      return notifications.filter((n) => ['SOS', 'SAFETY_CHECK', 'GEOFENCE'].includes(typeOf(n)));
    }
    if (activeFilter === 'Travel Updates') {
      return notifications.filter((n) => typeOf(n) === 'JOURNEY');
    }
    if (activeFilter === 'System') {
      return notifications.filter((n) => !['SOS', 'SAFETY_CHECK', 'GEOFENCE', 'JOURNEY'].includes(typeOf(n)));
    }
    return notifications;
  };

  const filteredItems = getFilteredNotifications();

  return (
    <Screen style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 }}>
          <TouchableOpacity onPress={toggleDrawer} accessibilityLabel="Open menu">
            <Ionicons name="menu" size={28} color={colors.primary} />
          </TouchableOpacity>
          <Text variant="headlineMd" style={{ fontWeight: 'bold', color: colors.primary, flexShrink: 1 }}>
            History & Alerts
          </Text>
        </View>
        <TouchableOpacity style={styles.headerBtn} onPress={fetchNotifications}>
          <Ionicons name="refresh-outline" size={24} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {/* Filters */}
      <View style={styles.filtersContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filtersScroll}>
          {filters.map(f => (
            <TouchableOpacity
              key={f}
              style={[styles.filterChip, activeFilter === f && styles.filterChipActive]}
              onPress={() => setActiveFilter(f)}
            >
              <Text
                variant="labelLg"
                style={{
                  color: activeFilter === f ? colors['on-secondary-container'] : colors['on-surface-variant'],
                  fontWeight: activeFilter === f ? 'bold' : 'normal',
                }}
              >
                {f}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {loading ? (
        <DataState loading={true} />
      ) : error ? (
        <DataState error={error} onRetry={fetchNotifications} />
      ) : filteredItems.length === 0 ? (
        <DataState
          empty
          emptyText={
            notifications.length === 0
              ? 'No notifications yet. You will see safety alerts and updates here.'
              : `No ${activeFilter} notifications found.`
          }
        />
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} />
          }
        >
          {filteredItems.map(item => {
            const isSos = ['SOS', 'SAFETY_CHECK'].includes(typeOf(item)) || item.title?.toLowerCase().includes('sos');
            const isWarning = typeOf(item) === 'GEOFENCE' || item.title?.toLowerCase().includes('warning');
            const itemKey = item._id || item.id || Math.random().toString();

            return (
              <View style={styles.timelineItem} key={itemKey}>
                <View
                  style={
                    isSos
                      ? styles.iconContainerError
                      : isWarning
                      ? styles.iconContainerWarning
                      : styles.iconContainerInfo
                  }
                >
                  <Ionicons
                    name={isSos ? 'warning' : isWarning ? 'alert' : 'information-circle'}
                    size={24}
                    color={colors.white}
                  />
                </View>

                <View style={isSos ? styles.cardError : styles.cardStandardFull}>
                  <View style={styles.cardHeader}>
                    <Text
                      variant="labelLg"
                      style={{ color: isSos ? colors.error : colors.primary, fontWeight: 'bold' }}
                    >
                      {item.title || 'Notification'}
                    </Text>
                    {item.createdAt ? (
                      <Text variant="labelMd" color={colors['on-surface-variant']}>
                        {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </Text>
                    ) : null}
                  </View>
                  <Text variant="bodyMd" color={colors['on-surface-variant']} style={{ marginTop: 6 }}>
                    {item.message || item.body || ''}
                  </Text>
                </View>
              </View>
            );
          })}
          <View style={{ height: 100 }} />
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
  },
  headerBtn: {
    padding: spacing.xs,
  },
  filtersContainer: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(217, 194, 183, 0.3)',
    paddingBottom: spacing.md,
  },
  filtersScroll: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  filterChip: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: colors['surface-container-high'],
    borderRadius: shapes.roundedPill,
  },
  filterChipActive: {
    backgroundColor: colors['secondary-container'],
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  timelineItem: {
    flexDirection: 'row',
    marginBottom: spacing.md,
  },
  iconContainerError: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.error,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  iconContainerWarning: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#EAB308',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  iconContainerInfo: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  cardError: {
    flex: 1,
    backgroundColor: 'rgba(255, 235, 238, 0.5)',
    borderWidth: 1,
    borderColor: 'rgba(186, 26, 26, 0.3)',
    borderRadius: shapes.roundedLg,
    padding: spacing.md,
  },
  cardStandardFull: {
    flex: 1,
    backgroundColor: colors['surface-container-low'],
    borderWidth: 1,
    borderColor: colors['surface-variant'],
    borderRadius: shapes.roundedLg,
    padding: spacing.md,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
});
