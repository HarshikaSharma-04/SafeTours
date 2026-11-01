import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { authService } from '../services/auth';
import { tokenStorage } from '../services/tokenStorage';
import { session } from '../services/session';
import { setUnauthorizedCallback, setAuthTokenHeader, formatApiError } from '../services/apiClient';
import { kvCache } from '../storage/kvCache';
import { stopBackgroundGeofence } from '../utils/backgroundGeofence';

const USER_CACHE_KEY = 'auth:user';
const RESTORE_RETRY_MS = 30000;

const AuthContext = createContext({});

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [tokens, setTokens] = useState(null);
  const [isProfileComplete, setIsProfileComplete] = useState(true);
  const [isLoading, setIsLoading] = useState(true);

  // The outbox only uploads rows that belong to the signed-in user.
  useEffect(() => {
    session.set(user ? user._id || user.id || null : null);
  }, [user]);
  const [authError, setAuthError] = useState(null);

  const clearError = () => setAuthError(null);

  const handleUnauthorized = useCallback(async () => {
    await tokenStorage.clearTokens();
    setAuthTokenHeader(null);
    setTokens(null);
    setUser(null);
    setIsLoading(false);
  }, []);

  // Restore session on app launch
  useEffect(() => {
    setUnauthorizedCallback(handleUnauthorized);
    let retryTimer = null;
    let cancelled = false;

    // Started offline: keep trying quietly, so the real user replaces the cached copy once the server answers.
    const refreshUserLater = () => {
      retryTimer = setTimeout(async () => {
        if (cancelled) return;
        try {
          const fresh = await authService.getMe();
          setUser(fresh);
          kvCache.set(USER_CACHE_KEY, fresh);
        } catch (err) {
          if (!err?.response) refreshUserLater();
        }
      }, RESTORE_RETRY_MS);
    };

    const restoreSession = async () => {
      try {
        const [accessToken, refreshToken] = await Promise.all([
          tokenStorage.getAccessToken(),
          tokenStorage.getRefreshToken(),
        ]);

        if (!accessToken) {
          setIsLoading(false);
          return;
        }

        setAuthTokenHeader(accessToken);
        setTokens({ accessToken, refreshToken });

        // Fetch current user from backend
        const authenticatedUser = await authService.getMe();
        setUser(authenticatedUser);
        kvCache.set(USER_CACHE_KEY, authenticatedUser);
        setIsProfileComplete(true);
      } catch (err) {
        console.warn('Session restoration failed:', err?.message || err);
        const status = err?.response?.status;
        const stillSignedIn = Boolean(await tokenStorage.getAccessToken());
        if (status === 400 || status === 401 || !stillSignedIn) {
          await tokenStorage.clearTokens();
          setAuthTokenHeader(null);
          setTokens(null);
          setUser(null);
        } else {
          // No connection, or the server is down: the tokens are still good, so stay signed in. SOS, cached risk and
          // the offline assistant must keep working when the app is opened with no signal.
          const cached = await kvCache.get(USER_CACHE_KEY, { allowExpired: true });
          setUser(cached ? cached.value : {});
          setIsProfileComplete(true);
          refreshUserLater();
        }
      } finally {
        setIsLoading(false);
      }
    };

    restoreSession();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [handleUnauthorized]);

  const establishSession = async authData => {
    const { user: safeUser, accessToken, refreshToken } = authData;
    const nextTokens = { accessToken, refreshToken };

    await Promise.all([
      tokenStorage.saveAccessToken(accessToken),
      tokenStorage.saveRefreshToken(refreshToken),
    ]);

    setAuthTokenHeader(accessToken);
    setTokens(nextTokens);
    
    // If backend response included user info, set it; otherwise fetch from /me
    let currentUser = safeUser;
    if (!currentUser) {
      currentUser = await authService.getMe();
    }

    setUser(currentUser);
    kvCache.set(USER_CACHE_KEY, currentUser);
    setIsProfileComplete(true);
    setAuthError(null);
    return currentUser;
  };

  const login = async (email, password) => {
    setAuthError(null);
    try {
      const authData = await authService.login({ email, password });
      return await establishSession(authData);
    } catch (err) {
      const formatted = formatApiError(err);
      setAuthError(formatted);
      throw formatted;
    }
  };

  const signup = async (username, email, password) => {
    setAuthError(null);
    try {
      const authData = await authService.signup({ username, email, password });
      return await establishSession(authData);
    } catch (err) {
      const formatted = formatApiError(err);
      setAuthError(formatted);
      throw formatted;
    }
  };

  const logout = async () => {
    setIsLoading(true);
    try {
      // Best effort: signing out must also work with no connection.
      const storedRefresh = (await tokenStorage.getRefreshToken()) || tokens?.refreshToken;
      if (storedRefresh) await authService.logout(storedRefresh).catch(() => {});
      await stopBackgroundGeofence();
      await kvCache.set(USER_CACHE_KEY, null);
      await tokenStorage.clearTokens();
      setAuthTokenHeader(null);
      setTokens(null);
      setUser(null);
      setAuthError(null);
    } finally {
      setIsLoading(false);
    }
  };

  const refreshAccessToken = async () => {
    const currentRefresh = (await tokenStorage.getRefreshToken()) || tokens?.refreshToken;
    if (!currentRefresh) throw new Error('No refresh token available');

    const refreshed = await authService.refreshToken(currentRefresh);
    const nextTokens = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || currentRefresh,
    };

    await Promise.all([
      tokenStorage.saveAccessToken(nextTokens.accessToken),
      tokenStorage.saveRefreshToken(nextTokens.refreshToken),
    ]);

    setAuthTokenHeader(nextTokens.accessToken);
    setTokens(nextTokens);
    return nextTokens.accessToken;
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        currentUser: user,
        isAuthenticated: Boolean(user),
        accessToken: tokens?.accessToken || null,
        refreshToken: tokens?.refreshToken || null,
        tokens,
        isProfileComplete,
        isLoading,
        loading: isLoading,
        authError,
        clearError,
        login,
        signup,
        logout,
        refreshAccessToken,
        setUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
