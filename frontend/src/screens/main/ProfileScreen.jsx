import React, { useEffect, useState } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TextInput,
  Switch,
  Image,
  TouchableOpacity,
} from 'react-native';
import { Screen } from '../../components/Screen';
import { Text } from '../../components/Text';
import { Toast } from '../../components/Toast';
import { colors, spacing, shapes, typography } from '../../theme/theme';
import { profileService } from '../../services/profile';
import { formatApiError } from '../../services/apiClient';
import { useAuth } from '../../context/AuthContext';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';


const blankMedical = {
  bloodGroup: '',
  allergies: '',
  medicalConditions: '',
  currentMedications: '',
  doctorName: '',
  doctorPhone: '',
  additionalNotes: '',
  organDonor: false,
  wheelchairRequired: false,
};

const blankSettings = {
  autoSosOnFall: false,
  lowBatteryAlert: true,
  shareLiveLocationWithContacts: true,
  quietHoursEnabled: false,
};

export const ProfileScreen = () => {
  const navigation = useNavigation();
  const { logout, isProfileComplete } = useAuth();

  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);
  const [toastType, setToastType] = useState('error');

  useEffect(() => {
    profileService
      .getProfile()
      .then(data => {
        const addressText =
          typeof data.address === 'object' && data.address !== null
            ? data.address.street || data.address.city || ''
            : data.address || '';

        const medicalData = data.medicalInfo || data.medical || {};
        const settingsData = data.emergencySettings || data.settings || {};

        setForm({
          ...data,
          name: data.name || data.username || '',
          address: addressText,
          languages: Array.isArray(data.languages) ? data.languages : [],
          medical: {
            ...blankMedical,
            ...medicalData,
            bloodGroup: data.bloodGroup || medicalData.bloodGroup || '',
          },
          settings: {
            ...blankSettings,
            ...settingsData,
            autoSosOnFall: Boolean(settingsData.autoSOS ?? settingsData.autoSosOnFall ?? false),
            shareLiveLocationWithContacts: Boolean(
              settingsData.shareLiveLocation ?? settingsData.shareLiveLocationWithContacts ?? true
            ),
          },
        });
      })
      .catch(err => {
        const formatted = formatApiError(err);
        setToastMessage(formatted.message);
        setToastType('error');
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const update = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const updateMedical = (key, value) =>
    setForm(current => ({ ...current, medical: { ...current.medical, [key]: value } }));
  const updateSettings = (key, value) =>
    setForm(current => ({ ...current, settings: { ...current.settings, [key]: value } }));

  const saveProfile = async () => {
    setSaving(true);
    setToastMessage(null);
    try {
      const { medical, settings, ...personal } = form;
      await Promise.all([
        profileService.updateProfile(personal),
        profileService.updateMedical(medical),
        profileService.updateSettings(settings),
      ]);
      setToastMessage('Profile updated successfully!');
      setToastType('success');
      setTimeout(() => {
        if (navigation.canGoBack()) navigation.goBack();
      }, 1000);
    } catch (err) {
      const formatted = formatApiError(err);
      setToastMessage(formatted.message);
      setToastType('error');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !form) {
    return (
      <Screen style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </Screen>
    );
  }

  const initials = form.name || form.username ? (form.name || form.username).slice(0, 2).toUpperCase() : 'ST';

  return (
    <Screen style={styles.container}>
      <Toast
        message={toastMessage}
        type={toastType}
        onDismiss={() => setToastMessage(null)}
      />

      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Ionicons name="arrow-back" size={24} color={colors.primary} />
          </TouchableOpacity>

          <Text variant="headlineMd" style={styles.headerTitle}>SafeTours</Text>
        </View>
        <View style={styles.profilePicContainer}>
          {form.profileImage ? (
            <Image source={{ uri: form.profileImage }} style={styles.profilePic} />
          ) : (
            <Text color={colors.primary}>{initials}</Text>
          )}
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.sectionHeader}>
          <Text variant="headlineLg" style={styles.pageTitle}>
            Edit Profile
          </Text>
          <Text variant="bodyMd" color={colors['on-surface-variant']}>
            Your safety is our priority. Keep your information up to date.
          </Text>
        </View>

        <View style={styles.profileCard}>
          <Section title="Personal information" />
          <Field label="Full Name" value={form.name || ''} onChangeText={value => update('name', value)} icon="person" editable={!saving} />
          <Field label="Phone Number" value={form.phone || ''} onChangeText={value => update('phone', value)} icon="call" keyboardType="phone-pad" editable={!saving} />
          <Field label="Address" value={form.address || ''} onChangeText={value => update('address', value)} icon="location" editable={!saving} />
          <Field label="Nationality" value={form.nationality || ''} onChangeText={value => update('nationality', value)} editable={!saving} />
          <Field
            label="Languages (comma separated)"
            value={form.languages ? form.languages.join(', ') : ''}
            onChangeText={value =>
              update('languages', value.split(',').map(item => item.trim()).filter(Boolean))
            }
            editable={!saving}
          />
          <Field label="Gender" value={form.gender || ''} onChangeText={value => update('gender', value)} editable={!saving} />
          <Field label="Date of Birth" value={form.dateOfBirth || ''} onChangeText={value => update('dateOfBirth', value)} placeholder="YYYY-MM-DD" editable={!saving} />
          <Field label="Profile Image URL" value={form.profileImage || ''} onChangeText={value => update('profileImage', value)} editable={!saving} />

          <Section title="Medical information" />
          <Field label="Blood Group" value={form.medical.bloodGroup || ''} onChangeText={value => updateMedical('bloodGroup', value)} editable={!saving} />
          <Field label="Allergies" value={form.medical.allergies || ''} onChangeText={value => updateMedical('allergies', value)} multiline editable={!saving} />
          <Field label="Medical Conditions" value={form.medical.medicalConditions || ''} onChangeText={value => updateMedical('medicalConditions', value)} multiline editable={!saving} />
          <Field label="Current Medications" value={form.medical.currentMedications || ''} onChangeText={value => updateMedical('currentMedications', value)} multiline editable={!saving} />
          <Field label="Doctor Name" value={form.medical.doctorName || ''} onChangeText={value => updateMedical('doctorName', value)} editable={!saving} />
          <Field label="Doctor Phone" value={form.medical.doctorPhone || ''} onChangeText={value => updateMedical('doctorPhone', value)} keyboardType="phone-pad" editable={!saving} />
          <Field label="Additional Notes" value={form.medical.additionalNotes || ''} onChangeText={value => updateMedical('additionalNotes', value)} multiline editable={!saving} />
          <Toggle label="Organ Donor" value={Boolean(form.medical.organDonor)} onValueChange={value => updateMedical('organDonor', value)} disabled={saving} />
          <Toggle label="Wheelchair Required" value={Boolean(form.medical.wheelchairRequired)} onValueChange={value => updateMedical('wheelchairRequired', value)} disabled={saving} />

          <Section title="Emergency settings" />
          <Toggle label="Share Live Location with Contacts" value={Boolean(form.settings.shareLiveLocationWithContacts)} onValueChange={value => updateSettings('shareLiveLocationWithContacts', value)} disabled={saving} />
          <Toggle label="Ask if I am safe when I enter a high-risk area" value={Boolean(form.settings.autoSosOnFall)} onValueChange={value => updateSettings('autoSosOnFall', value)} disabled={saving} />
          <Toggle label="Low Battery Alert" value={Boolean(form.settings.lowBatteryAlert)} onValueChange={value => updateSettings('lowBatteryAlert', value)} disabled={saving} />
          <Toggle label="Quiet Hours Enabled" value={Boolean(form.settings.quietHoursEnabled)} onValueChange={value => updateSettings('quietHoursEnabled', value)} disabled={saving} />
        </View>
        <View style={{ height: 120 }} />
      </ScrollView>

      <View style={styles.bottomActions}>
        <TouchableOpacity style={styles.continueBtn} onPress={saveProfile} disabled={saving}>
          <Text variant="labelLg" color={colors['on-primary']} style={styles.continueText}>
            {saving ? 'Saving...' : 'Save Changes'}
          </Text>
          {saving ? (
            <ActivityIndicator size="small" color={colors['on-primary']} />
          ) : (
            <Ionicons name="arrow-forward" size={20} color={colors['on-primary']} />
          )}
        </TouchableOpacity>
        {!isProfileComplete && (
          <TouchableOpacity onPress={logout} style={styles.logoutBtn} disabled={saving}>
            <Text style={styles.logoutText}>Log Out</Text>
          </TouchableOpacity>
        )}
      </View>
    </Screen>
  );
};

const Section = ({ title }) => (
  <Text variant="labelLg" color={colors.primary} style={styles.groupTitle}>{title}</Text>
);

const Field = ({ label, icon, multiline, ...props }) => (
  <View style={styles.inputGroup}>
    <Text variant="labelLg" color={colors['on-surface-variant']} style={styles.inputLabel}>{label}</Text>
    <View style={styles.inputWrapper}>
      <TextInput
        {...props}
        style={[styles.input, multiline && styles.textArea]}
        multiline={multiline}
        placeholderTextColor="rgba(134, 115, 106, 0.5)"
        textAlignVertical={multiline ? 'top' : 'center'}
      />
      {icon && <Ionicons name={icon} size={20} color="rgba(134, 115, 106, 0.5)" style={styles.inputIcon} />}
    </View>
  </View>
);

const Toggle = ({ label, value, onValueChange, disabled }) => (
  <View style={styles.toggleContainer}>
    <Text variant="labelLg" style={styles.toggleTitle}>{label}</Text>
    <Switch
      trackColor={{ false: colors['outline-variant'], true: colors['primary-container'] }}
      thumbColor={colors['on-primary']}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
    />
  </View>
);

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: 'rgba(255, 248, 246, 0.9)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(217, 194, 183, 0.3)',
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
  headerTitle: { color: colors.primary, fontWeight: 'bold', flexShrink: 1 },
  profilePicContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors['surface-container-high'],
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(217, 194, 183, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profilePic: { width: '100%', height: '100%' },
  scrollContent: { padding: spacing.lg, paddingTop: spacing.xl },
  sectionHeader: { marginBottom: spacing.xl, gap: 8 },
  pageTitle: { fontSize: 28, fontWeight: 'bold', color: colors['on-surface'], letterSpacing: -0.5 },
  profileCard: {
    backgroundColor: '#F8F6F4',
    borderWidth: 1,
    borderColor: '#E7D6CC',
    borderRadius: shapes.roundedLg,
    padding: spacing.xl,
    gap: spacing.lg,
    elevation: 5,
  },
  groupTitle: { textTransform: 'uppercase', fontWeight: 'bold', marginTop: spacing.sm },
  inputGroup: { gap: 8 },
  inputLabel: { paddingHorizontal: 4 },
  inputWrapper: { position: 'relative', justifyContent: 'center' },
  input: {
    height: 56,
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    fontSize: typography.sizes.bodyLg,
    fontFamily: typography.fontFamily,
    color: colors['on-surface'],
  },
  inputIcon: { position: 'absolute', right: spacing.md },
  textArea: { height: 100, paddingVertical: spacing.md },
  toggleContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors['surface-container-low'],
    padding: spacing.md,
    borderRadius: 12,
  },
  toggleTitle: { fontWeight: '600', color: colors['on-surface'] },
  bottomActions: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.xl,
    backgroundColor: 'rgba(255, 248, 246, 0.9)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(217, 194, 183, 0.2)',
    alignItems: 'center',
    gap: spacing.md,
  },
  continueBtn: {
    width: '100%',
    height: 56,
    backgroundColor: colors['primary-container'],
    borderRadius: shapes.roundedPill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    elevation: 4,
  },
  continueText: { fontSize: 18 },
  logoutBtn: { marginTop: spacing.sm },
  logoutText: { color: colors.error, fontWeight: 'bold' },
});
