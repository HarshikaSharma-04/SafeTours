import React, { useState } from 'react';
import { View, StyleSheet, TouchableOpacity, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Screen } from '../../components/Screen';
import { Text } from '../../components/Text';
import { Input } from '../../components/Input';
import { Button } from '../../components/Button';
import { Toast } from '../../components/Toast';
import { colors, spacing } from '../../theme/theme';
import { useNavigation } from '@react-navigation/native';
import { useAuth } from '../../context/AuthContext';

const loginSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const LoginScreen = () => {
  const navigation = useNavigation();
  const { login, isLoading } = useAuth();
  const [errorMessage, setErrorMessage] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { control, handleSubmit, setError } = useForm({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  });

  const onSubmit = async data => {
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await login(data.email, data.password);
    } catch (err) {
      if (err.fieldErrors && Object.keys(err.fieldErrors).length > 0) {
        Object.entries(err.fieldErrors).forEach(([field, msg]) => {
          if (field === 'email' || field === 'password') {
            setError(field, { type: 'server', message: msg });
          }
        });
      }
      setErrorMessage(err.message || 'Login failed. Please check your credentials.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const isBusy = isSubmitting || isLoading;

  return (
    <Screen style={styles.screen}>
      <Toast message={errorMessage} type="error" onDismiss={() => setErrorMessage(null)} />
      <KeyboardAvoidingView 
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView 
          contentContainerStyle={styles.scrollContent} 
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Text variant="headlineLg" style={styles.title}>Welcome Back</Text>
            <Text variant="bodyMd" color={colors.textSecondary}>Sign in to your SafeTours account</Text>
          </View>
          
          <View style={styles.form}>
            <Input
              control={control}
              name="email"
              label="Email Address"
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              editable={!isBusy}
            />
            <Input
              control={control}
              name="password"
              label="Password"
              placeholder="••••••••"
              secureTextEntry
              editable={!isBusy}
            />
          </View>

          <TouchableOpacity style={styles.forgotLink} onPress={() => navigation.navigate('ForgotPassword')} disabled={isBusy}>
            <Text variant="labelLg" color={colors.primary}>Forgot password?</Text>
          </TouchableOpacity>

          <View style={styles.footer}>
            <Button
              title="Log In"
              onPress={handleSubmit(onSubmit)}
              isLoading={isBusy}
              disabled={isBusy}
            />
            <View style={styles.signupContainer}>
              <Text variant="bodyMd" color={colors.textSecondary}>Don't have an account? </Text>
              <TouchableOpacity onPress={() => navigation.navigate('Signup')} disabled={isBusy}>
                <Text variant="labelLg" color={colors.primary}>Sign Up</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  forgotLink: {
    alignSelf: 'flex-end',
    paddingVertical: spacing.sm,
  },
  screen: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    padding: spacing.containerMargin,
    justifyContent: 'space-between',
  },
  header: {
    marginTop: spacing.xl,
    marginBottom: spacing.xl,
  },
  title: {
    marginBottom: spacing.xs,
  },
  form: {
    flex: 1,
  },
  footer: {
    paddingBottom: spacing.lg,
    marginTop: spacing.lg,
  },
  signupContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
});
