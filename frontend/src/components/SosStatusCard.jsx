import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { colors, spacing, shapes } from '../theme/theme';

const TONE = {
  ok: { bg: '#E8F5E9', border: '#2E7D32', icon: 'checkmark-circle', color: '#1B5E20' },
  warn: { bg: '#FFF3E0', border: '#EF6C00', icon: 'time', color: '#9A4A00' },
  error: { bg: '#FFEBEE', border: '#C62828', icon: 'alert-circle', color: '#8E1B1B' },
};

/**
 * One SOS, told honestly. Three separate facts are shown side by side and never merged:
 *   Queued on this phone  /  SMS sent  /  Delivered to server
 * `view` comes from offline/smsLogic.sosView().
 */
export const SosStatusCard = ({ view, row, onCancel, onResend, busy }) => {
  const tone = TONE[view.tone] || TONE.warn;
  const sms = row.payload && row.payload.sms;
  const canResend = onResend && sms && ['failed', 'partial', 'composer_opened', 'no_permission'].includes(sms.outcome);
  return (
    <View style={[styles.card, { backgroundColor: tone.bg, borderColor: tone.border }]}>
      <View style={styles.head}>
        <Ionicons name={tone.icon} size={22} color={tone.color} />
        <Text variant="labelLg" style={{ color: tone.color, fontWeight: 'bold', flex: 1 }}>{view.headline}</Text>
      </View>

      <View style={styles.chips}>
        {view.chips.map((c) => (
          <View key={c.key} style={[styles.chip, c.on ? styles.chipOn : styles.chipOff]}>
            <Ionicons name={c.on ? 'checkmark' : 'ellipse-outline'} size={12} color={c.on ? '#fff' : colors['on-surface-variant']} />
            <Text variant="labelSm" style={{ color: c.on ? '#fff' : colors['on-surface-variant'], fontWeight: '700' }}>{c.label}</Text>
          </View>
        ))}
      </View>

      {view.detail.map((d, i) => (
        <Text key={i} variant="labelMd" style={{ color: tone.color }}>{d}</Text>
      ))}
      {sms && sms.message && sms.message.cut && sms.message.cut.length > 0 && (
        <Text variant="labelSm" style={{ color: tone.color, opacity: 0.8 }}>Text shortened to fit {sms.message.segments} message(s): {sms.message.cut.join('; ')}.</Text>
      )}

      <View style={styles.actions}>
        {canResend && (
          <TouchableOpacity style={styles.btn} onPress={onResend} disabled={busy} accessibilityRole="button">
            <Text variant="labelMd" style={{ color: colors.primary, fontWeight: 'bold' }}>Resend text</Text>
          </TouchableOpacity>
        )}
        {onCancel && !(row.payload && row.payload.cancelled) && (
          <TouchableOpacity style={[styles.btn, styles.btnDanger]} onPress={onCancel} disabled={busy} accessibilityRole="button">
            <Text variant="labelMd" style={{ color: colors.error, fontWeight: 'bold' }}>Cancel this SOS</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: shapes.roundedLg, padding: spacing.md, gap: 8, marginBottom: spacing.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999 },
  chipOn: { backgroundColor: '#2E7D32' },
  chipOff: { backgroundColor: 'rgba(0,0,0,0.07)' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  btn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: colors.primary, backgroundColor: '#fff' },
  btnDanger: { borderColor: colors.error },
});
