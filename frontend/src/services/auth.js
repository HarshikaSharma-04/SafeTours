import { apiClient } from './apiClient';

export const authService = {
  /**
   * POST /api/auth/signup
   * @param {Object} payload { username, email, password }
   */
  signup: async ({ username, email, password }) => {
    const response = await apiClient.post('/auth/signup', {
      username,
      email,
      password,
    });
    // Response envelope: { statusCode, data: { user, accessToken, refreshToken }, message, success }
    return response.data.data;
  },

  /**
   * POST /api/auth/login
   * @param {Object} payload { email, password }
   */
  login: async ({ email, password }) => {
    const response = await apiClient.post('/auth/login', {
      email,
      password,
    });
    return response.data.data;
  },

  /**
   * GET /api/auth/me
   * Fetches the current authenticated user's profile using the attached Bearer token.
   */
  getMe: async () => {
    const response = await apiClient.get('/auth/me');
    return response.data.data.user;
  },

  /**
   * POST /api/auth/logout
   * Revokes the refresh token on the server.
   */
  logout: async refreshToken => {
    await apiClient.post('/auth/logout', { refreshToken }, { timeout: 5000 });
  },

  /**
   * POST /api/auth/forgot-password
   */
  forgotPassword: async email => {
    await apiClient.post('/auth/forgot-password', { email });
  },

  /**
   * POST /api/auth/reset-password
   */
  resetPassword: async ({ email, code, password }) => {
    await apiClient.post('/auth/reset-password', { email, code, password });
  },

  /**
   * POST /api/auth/refresh-token
   * @param {string} refreshToken 
   */
  refreshToken: async refreshToken => {
    const response = await apiClient.post('/auth/refresh-token', {
      refreshToken,
    });
    return response.data.data;
  },
};
