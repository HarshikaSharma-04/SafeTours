import axios from 'axios';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { tokenStorage } from './tokenStorage';
import { connectivityBus } from '../connectivity/connectivityBus';

// Helper to extract Metro bundler host IP when running via Expo Go (on physical phone or emulator)
const getMetroHostIp = () => {
  const hostUri =
    Constants.expoConfig?.hostUri ||
    Constants.manifest?.debuggerHost ||
    Constants.manifest2?.extra?.expoGo?.developer?.tool;
  if (hostUri) {
    const ip = hostUri.split(':')[0];
    if (ip && ip !== 'localhost' && ip !== '127.0.0.1') {
      return ip;
    }
  }
  return null;
};

// Base URL configuration for Expo Dev / Web / Physical Mobile Device / Android Emulator / Production
const getBaseUrl = () => {
  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL;
  }

  // Auto-detect host machine IP when app is scanned on physical phone via Expo Go
  const metroHost = getMetroHostIp();
  if (metroHost) {
    return `http://${metroHost}:5001/api`;
  }

  if (Platform.OS === 'android') {
    return 'http://10.0.2.2:5001/api';
  }
  return 'http://localhost:5001/api';
};

export const BASE_URL = getBaseUrl();
console.log('🔗 [SafeTours API] Configured BASE_URL:', BASE_URL);

export const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

/**
 * Helper to update or remove the default Authorization header on apiClient
 */
export const setAuthTokenHeader = token => {
  if (token) {
    apiClient.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete apiClient.defaults.headers.common.Authorization;
  }
};

// Event listener mechanism for unauthorized (401) logout handling
let onUnauthorizedCallback = null;

export const setUnauthorizedCallback = callback => {
  onUnauthorizedCallback = callback;
};

// Request Interceptor: Attach JWT access token automatically
apiClient.interceptors.request.use(
  async config => {
    // "Offline mode" test switch: fail like a dead network, without touching the network.
    if (connectivityBus.isForcedOffline()) {
      const error = new Error('Offline mode is switched on');
      error.code = 'FORCED_OFFLINE';
      error.config = config;
      return Promise.reject(error);
    }
    config.metadata = { startedAt: Date.now() };
    try {
      const token = await tokenStorage.getAccessToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    } catch (err) {
      console.warn('Error reading access token in request interceptor:', err);
    }
    return config;
  },
  error => Promise.reject(error)
);

// Response Interceptor: Handle 401 and refresh tokens
let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach(prom => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

// Reports each outcome to the connectivity monitor. A response from the server (even 4xx) proves the server is
// reachable; timeouts, network errors and 502/503/504 count as failures. Local/forced failures are not reported.
const reportOutcome = (config, status, hadResponse) => {
  if (!config || !config.metadata) return;
  const ms = Date.now() - config.metadata.startedAt;
  const failed = !hadResponse || status === 502 || status === 503 || status === 504;
  connectivityBus.reportRequest({ ok: !failed, ms });
};

// False when there was no refresh token to try at all (as opposed to a request that failed).
const storedRefreshTokenWasUsable = refreshErr => refreshErr.message !== 'No refresh token available';

apiClient.interceptors.response.use(
  response => {
    reportOutcome(response.config, response.status, true);
    return response;
  },
  async error => {
    if (error.code !== 'FORCED_OFFLINE') reportOutcome(error.config, error.response?.status, Boolean(error.response));
    const originalRequest = error.config;

    // Do not attempt refresh on auth endpoints (login, signup, refresh-token)
    const isAuthRoute =
      originalRequest?.url?.includes('/auth/login') ||
      originalRequest?.url?.includes('/auth/signup') ||
      originalRequest?.url?.includes('/auth/refresh-token') ||
      originalRequest?.url?.includes('/auth/logout') ||
      originalRequest?.url?.includes('/auth/forgot-password') ||
      originalRequest?.url?.includes('/auth/reset-password');

    if (error.response?.status === 401 && originalRequest && !originalRequest._retry && !isAuthRoute) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then(token => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            return apiClient(originalRequest);
          })
          .catch(err => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const storedRefreshToken = await tokenStorage.getRefreshToken();
        if (!storedRefreshToken) {
          throw new Error('No refresh token available');
        }

        // Call backend refresh token endpoint
        const refreshResponse = await axios.post(
          `${BASE_URL}/auth/refresh-token`,
          { refreshToken: storedRefreshToken },
          { timeout: 15000 }
        );

        const { accessToken, refreshToken: newRefreshToken } = refreshResponse.data.data;

        await tokenStorage.saveAccessToken(accessToken);
        if (newRefreshToken) {
          await tokenStorage.saveRefreshToken(newRefreshToken);
        }

        setAuthTokenHeader(accessToken);
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;

        processQueue(null, accessToken);
        return apiClient(originalRequest);
      } catch (refreshErr) {
        processQueue(refreshErr, null);
        // Only the server saying no ends the session. A dropped connection or a server error must not sign the
        // user out: this is a safety app, and the moment the signal goes is when it matters most.
        const status = refreshErr.response?.status;
        const sessionIsOver = !storedRefreshTokenWasUsable(refreshErr) || status === 400 || status === 401;
        if (sessionIsOver) {
          await tokenStorage.clearTokens();
          setAuthTokenHeader(null);
          if (onUnauthorizedCallback) {
            onUnauthorizedCallback();
          }
        }
        return Promise.reject(refreshErr);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

/**
 * Helper to format API errors consistently across screens & services
 */
export const formatApiError = error => {
  if (!error) {
    return { message: 'An unknown error occurred.', status: 0, fieldErrors: {} };
  }

  if (typeof error === 'string') {
    return { message: error, status: 0, fieldErrors: {} };
  }

  if (!error.response) {
    return {
      message: error.message || 'Network error. Please check your connection to SafeTours backend.',
      status: 0,
      fieldErrors: {},
    };
  }

  const data = error.response.data || {};
  const status = error.response.status;
  // The journey and community endpoints put the useful sentence in `error` and a generic one in `message`.
  const specific = status < 500 && typeof data.error === 'string' ? data.error : null;
  const message = specific || data.message || (status === 401 ? 'Unauthorized session' : 'An error occurred');

  const fieldErrors = {};
  if (Array.isArray(data.errors)) {
    data.errors.forEach(err => {
      if (err.field && err.message) {
        fieldErrors[err.field] = err.message;
      }
    });
  }

  return {
    message,
    status,
    fieldErrors,
  };
};
