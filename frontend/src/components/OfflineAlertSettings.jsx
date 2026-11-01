import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, Switch, TextInput, Alert, Platform } from 'react-native';
import { Text } from './Text';
import { colors, spacing, shapes } from '../theme/theme';
import { useOutbox } from '../context/OutboxContext';
import { useConnectivity } from '../context/ConnectivityContext';
import { useSosTrigger } from '../context/SosTriggerContext';
import { outboxStore, getCapStats } from '../storage/outboxStore';
import { outboxRunner } from '../services/outboxRunner';
import { contactsCache } from '../services/contactsCache';
import { profileService } from '../services/profile';
import { smsPermissionStatus, directSmsSupported } from '../services/smsSender';
import { sendTestSmsToSelf, previewSosSms } from '../services/sosDispatcher';
import { explainAndRequestSmsPermission } from '../utils/smsPermissionFlow';
import { formatAge } from '../utils/geo';
import { sms as smsCfg } from '../offline/offlineConfig';

/**
 * Settings sections for phase 6B: emergency contacts sync, SMS permission, the SOS text (preview, custom sentence,
 * test to yourself), triggers (volume buttons, notification shortcut) and the outbox viewer.
 */
const TYPE_LABEL = {
  sos: 'SOS',
  sos_cancel: 'SOS cancellation',
  journey_update: 'Journey update',
  geofence_event: 'Geofence event',
  community_report: 'Community report',
  location_point: 'Location points',
};
const ago = (ts) => (ts ? formatAge(Date.now() - ts) || 'just now' : 'never');

const Section = ({ title, children }) => (
  <>
    <Text variant="labelSm" color={colors.primary} style={styles.sectionHeader}>{title}</Text>
    <View style={styles.card}>{children}</View>
  </>
);
const Row = ({ title, subtitle, right, onPress, last }) => (
  <>
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={onPress ? 0.7 : 1} disabled={!onPress}>
      <View style={{ flex: 1, paddingRight: 8 }}>
        <Text variant="labelLg" style={{ fontWeight: 'bold' }}>{title}</Text>
        {subtitle ? <Text variant="bodyMd" color={colors['on-surface-variant']}>{subtitle}</Text> : null}
      </View>
      {right}
    </TouchableOpacity>
    {!last && <View style={styles.divider} />}
  </>
);
const Pill = ({ label, onPress, danger, disabled }) => (
  <TouchableOpacity onPress={onPress} disabled={disabled} style={[styles.pill, danger && { borderColor: colors.error }, disabled && { opacity: 0.4 }]}>
    <Text variant="labelMd" style={{ color: danger ? colors.error : colors.primary, fontWeight: 'bold' }}>{label}</Text>
  </TouchableOpacity>
);

export const EmergencyAlertsSettings = () => {
  const [contacts, setContacts] = useState(null);
  const [perm, setPerm] = useState(null);
  const [custom, setCustom] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const trigger = useSosTrigger();
  const conn = useConnectivity();

  const load = useCallback(async () => {
    setContacts(await contactsCache.get());
    setPerm(await smsPermissionStatus());
    const p = await profileService.getCachedSosProfile();
    setCustom((p && p.customSosMessage) || '');
    setPreview(await previewSosSms());
  }, []);
  useEffect(() => { load(); }, [load]);

  const syncContacts = async () => {
    setBusy(true);
    const r = await contactsCache.refresh();
    setBusy(false);
    if (!r.ok) Alert.alert('Could not sync', 'No connection to the server. The saved copy on this phone is still used for SOS texts.');
    load();
  };

  const grant = async () => {
    await explainAndRequestSmsPermission();
    load();
  };

  const saveCustom = async () => {
    setBusy(true);
    try {
      await profileService.updateSosMessage(custom.trim());
      Alert.alert('Saved', 'Your SOS sentence was saved and is stored on this phone for offline use.');
    } catch (e) {
      Alert.alert('Could not save', conn.isOffline ? 'You are offline. Try again when you are connected.' : e.message || 'Try again.');
    }
    setBusy(false);
    load();
  };

  const test = async () => {
    setBusy(true);
    const r = await sendTestSmsToSelf();
    setBusy(false);
    Alert.alert(
      'Test SMS to myself',
      r.outcome === 'no_number' ? r.message
        : r.outcome === 'sent' ? `Sent to your own number (${r.segments} message segment${r.segments === 1 ? '' : 's'}).`
        : r.outcome === 'composer_opened' ? 'Your messaging app opened with the test text. Tap Send there.'
        : r.outcome === 'no_permission' ? 'SMS permission is off, so nothing was sent.'
        : `Not sent${r.reason ? `: ${r.reason}` : ''}.`
    );
  };

  const permText = Platform.OS !== 'android' ? 'iPhones cannot send texts silently: the message opens ready and you tap Send.'
    : !directSmsSupported ? 'This build cannot text directly (Expo Go): the message opens ready and you tap Send. Install the development build.'
    : perm === 'granted' ? 'Allowed: texts are sent directly from this phone.'
    : perm === 'blocked' ? 'Blocked in Android settings: the message opens ready and you tap Send. Press Grant to open Settings.'
    : perm === 'denied' ? 'Not allowed: the message opens ready and you tap Send.'
    : 'Not asked yet: you will be asked the first time you press SOS.';

  return (
    <>
      <Section title="EMERGENCY ALERTS (NO SIGNAL)">
        <Row
          title="Emergency contacts on this phone"
          subtitle={contacts ? `${contacts.contacts.length} contact(s), synced ${ago(contacts.syncedAt)}. Used to text them when there is no internet.` : 'Not synced yet. Connect once so SOS texts can work offline.'}
          right={<Pill label="Sync now" onPress={syncContacts} disabled={busy || conn.isOffline} />}
        />
        <Row
          title="SMS permission"
          subtitle={permText}
          right={directSmsSupported && perm !== 'granted' ? <Pill label="Grant" onPress={grant} /> : null}
        />
        <Row title="Test SMS to myself" subtitle="Sends one test text to the number in your own profile (nobody else)." right={<Pill label="Send" onPress={test} disabled={busy} />} last />
      </Section>

      <Section title="SOS TEXT MESSAGE">
        <View style={{ padding: spacing.md, gap: 8 }}>
          <Text variant="labelMd" color={colors['on-surface-variant']}>Your sentence (added at the end, max {smsCfg.customTextMax} characters)</Text>
          <TextInput
            value={custom}
            onChangeText={(t) => setCustom(t.slice(0, smsCfg.customTextMax))}
            placeholder="e.g. I have asthma. Call my brother first."
            style={styles.input}
            multiline
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pill label="Save" onPress={saveCustom} disabled={busy} />
            <Pill label="Update preview" onPress={load} />
          </View>
          {preview && (
            <View style={styles.preview}>
              <Text variant="labelSm" color={colors['on-surface-variant']}>Preview{preview.usingExampleLocation ? ' (example location)' : ''}</Text>
              <Text variant="bodyMd">{preview.text}</Text>
              <Text variant="labelSm" color={colors['on-surface-variant']}>
                {preview.segments} message segment{preview.segments === 1 ? '' : 's'} ({preview.encoding}){preview.cut.length ? `. Cut to fit: ${preview.cut.join('; ')}` : ''}.
              </Text>
            </View>
          )}
        </View>
      </Section>

      <Section title="SOS TRIGGERS">
        <Row
          title="Volume buttons (3 presses)"
          subtitle={trigger.hardware.supported ? 'Works only while SafeTours is open on screen. It cannot read the buttons with the screen off or the app in the background. You get 3 seconds to cancel.' : 'Not available in this build (needs the development build with the volume module).'}
          right={<Switch value={trigger.hardware.enabled} onValueChange={trigger.hardware.setEnabled} disabled={!trigger.hardware.supported} trackColor={{ false: colors.outline, true: colors.primary }} />}
        />
        <Row
          title="SOS notification shortcut"
          subtitle={trigger.shortcut.supported ? 'A notification you tap to start an SOS (3 seconds to cancel). A locked phone asks you to unlock first, and you can swipe it away on Android 14+.' : 'Android only.'}
          right={<Switch value={trigger.shortcut.enabled} onValueChange={trigger.shortcut.setEnabled} disabled={!trigger.shortcut.supported} trackColor={{ false: colors.outline, true: colors.primary }} />}
          last
        />
      </Section>
    </>
  );
};

export const OutboxSettings = () => {
  const { summary, refresh } = useOutbox();
  const conn = useConnectivity();
  const [problems, setProblems] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setProblems(await outboxStore.list({ statuses: ['dead', 'failed'], limit: 30 }));
    } catch (e) {
      setProblems([]);
    }
  }, []);
  useEffect(() => { load(); }, [load, summary.dead, summary.failed, summary.waiting]);

  const act = async (fn) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); await refresh(); await load(); }
  };

  const byType = Object.entries(summary.byType || {}).map(([t, n]) => `${TYPE_LABEL[t] || t} ${n}`).join(', ');
  const cap = getCapStats();

  return (
    <Section title="UPLOAD QUEUE">
      <Row
        title={`${summary.waiting} waiting to upload`}
        subtitle={`${byType || 'Nothing queued'}. Last upload: ${ago(summary.lastSyncAt)}.${conn.state === 'OFFLINE' ? ' Offline: it uploads when you reconnect.' : ''}`}
        right={<Pill label="Upload now" onPress={() => act(() => outboxRunner.drain())} disabled={busy || conn.state === 'OFFLINE'} />}
      />
      <Row
        title={`${summary.dead + summary.failed} need attention`}
        subtitle={summary.dead + summary.failed ? 'Rejected by the server or gave up after repeated errors. Retry or discard each one below.' : 'Nothing was rejected.'}
        right={summary.dead + summary.failed ? <Pill label="Retry all" onPress={() => act(async () => { for (const r of problems) await outboxStore.retry(r.id); outboxRunner.kick(0); })} disabled={busy} /> : null}
      />
      {problems.map((r) => (
        <View key={r.id} style={styles.problem}>
          <Text variant="labelLg" style={{ fontWeight: 'bold' }}>{TYPE_LABEL[r.type] || r.type} ({r.status === 'dead' ? 'rejected' : 'gave up'})</Text>
          <Text variant="labelSm" color={colors['on-surface-variant']}>Created {ago(r.createdAt)}. {r.lastError || ''}</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
            <Pill label="Retry" onPress={() => act(async () => { await outboxStore.retry(r.id); outboxRunner.kick(0); })} disabled={busy} />
            <Pill label="Discard" danger onPress={() => Alert.alert('Discard?', 'This item will never be uploaded.', [{ text: 'Keep', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => act(() => outboxStore.discard(r.id)) }])} disabled={busy} />
          </View>
        </View>
      ))}
      {(cap.dropped > 0 || cap.refused > 0) && (
        <Row
          title="The queue limit was reached"
          subtitle={`The queue holds at most 3,000 items. ${cap.dropped} oldest item(s) (location points first, then events, reports, journey updates) were dropped${cap.refused ? ` and ${cap.refused} new item(s) were refused` : ''}. SOS items are never dropped.`}
        />
      )}
      <Row title="Clear uploaded items" subtitle={`${summary.sent || 0} delivered item(s) kept for 24 hours.`} right={<Pill label="Clear" onPress={() => act(() => outboxStore.clearSent())} disabled={busy || !summary.sent} />} last />
    </Section>
  );
};

const styles = StyleSheet.create({
  sectionHeader: { textTransform: 'uppercase', letterSpacing: 1, marginBottom: spacing.sm, marginLeft: spacing.sm, fontWeight: 'bold' },
  card: { backgroundColor: colors.white, borderRadius: shapes.roundedLg, marginBottom: spacing.xl, borderWidth: 1, borderColor: colors['outline-variant'], overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', padding: spacing.md },
  divider: { height: 1, backgroundColor: colors['outline-variant'], marginLeft: spacing.md },
  pill: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: colors.primary, backgroundColor: '#fff' },
  input: { borderWidth: 1, borderColor: colors['outline-variant'], borderRadius: shapes.roundedLg, padding: spacing.sm, minHeight: 60, textAlignVertical: 'top' },
  preview: { backgroundColor: colors['surface-container-low'], borderRadius: shapes.roundedLg, padding: spacing.sm, gap: 4 },
  problem: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors['outline-variant'] },
});
