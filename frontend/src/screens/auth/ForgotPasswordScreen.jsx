import React from 'react';
import { View, StyleSheet, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
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
import { authService } from '../../services/auth';
import { formatApiError } from '../../services/apiClient';

const emailSchema = z.object({
    email: z.string().email('Invalid email address'),
});

const resetSchema = z.object({
    code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
});

export const ForgotPasswordScreen = () => {
    const navigation = useNavigation();
    const [isLoading, setIsLoading] = React.useState(false);
    const [error, setError] = React.useState(null);
    const [email, setEmail] = React.useState(null); // set once a code has been requested
    const [isDone, setIsDone] = React.useState(false);

    const emailForm = useForm({ resolver: zodResolver(emailSchema) });
    const resetForm = useForm({ resolver: zodResolver(resetSchema) });

    const requestCode = async (data) => {
        setIsLoading(true);
        setError(null);
        try {
            const address = data.email.trim().toLowerCase();
            await authService.forgotPassword(address);
            setEmail(address);
        } catch (e) {
            setError(formatApiError(e).message);
        } finally {
            setIsLoading(false);
        }
    };

    const submitReset = async (data) => {
        setIsLoading(true);
        setError(null);
        try {
            await authService.resetPassword({ email, code: data.code, password: data.password });
            setIsDone(true);
        } catch (e) {
            setError(formatApiError(e).message);
        } finally {
            setIsLoading(false);
        }
    };

    if (isDone) {
        return (
            <Screen style={styles.screen}>
                <ScrollView contentContainerStyle={styles.scrollContent}>
                    <View style={styles.header}>
                        <Text variant="headlineLg" style={styles.title}>Password Updated</Text>
                        <Text variant="bodyMd" color={colors.textSecondary}>
                            You can now log in with your new password. Other devices have been signed out.
                        </Text>
                    </View>
                    <View style={styles.footer}>
                        <Button title="Back to Login" onPress={() => navigation.navigate('Login')}/>
                    </View>
                </ScrollView>
            </Screen>
        );
    }

    return (
        <Screen style={styles.screen}>
            <Toast message={error} type="error" onDismiss={() => setError(null)} />
            <KeyboardAvoidingView
                style={styles.keyboardView}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
                    <View style={styles.header}>
                        <Text variant="headlineLg" style={styles.title}>Reset Password</Text>
                        <Text variant="bodyMd" color={colors.textSecondary}>
                            {email
                                ? `If ${email} has an account, a 6-digit code is on its way. It expires in 15 minutes.`
                                : 'Enter your email address and we will send you a reset code.'}
                        </Text>
                    </View>

                    {email ? (
                        <View style={styles.form}>
                            <Input control={resetForm.control} name="code" label="Reset Code" placeholder="123456" keyboardType="number-pad" maxLength={6}/>
                            <Input control={resetForm.control} name="password" label="New Password" placeholder="••••••••" secureTextEntry/>
                        </View>
                    ) : (
                        <View style={styles.form}>
                            <Input control={emailForm.control} name="email" label="Email Address" placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none"/>
                        </View>
                    )}

                    <View style={styles.footer}>
                        {email ? (
                            <Button title="Set New Password" onPress={resetForm.handleSubmit(submitReset)} isLoading={isLoading} style={styles.button}/>
                        ) : (
                            <Button title="Send Reset Code" onPress={emailForm.handleSubmit(requestCode)} isLoading={isLoading} style={styles.button}/>
                        )}
                        <Button title="Back to Login" variant="secondary" onPress={() => navigation.navigate('Login')}/>
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>
        </Screen>
    );
};

const styles = StyleSheet.create({
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
    button: {
        marginBottom: spacing.md,
    },
});
