import { create } from 'zustand';
import { api, UserInfo } from '../lib/api';
import { runLocalDataMigration } from '../lib/local-data-migration';

interface AuthState {
    user: UserInfo | null;
    token: string | null;
    isLoading: boolean;
    isAuthenticated: boolean;

    login: (account: string, password: string) => Promise<void>;
    register: (account: string, password: string, inviteCode: string) => Promise<void>;
    logout: () => Promise<void>;
    loadUser: () => Promise<void>;
}

function readStoredToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('token');
}

const initialToken = readStoredToken();

export const useAuthStore = create<AuthState>((set) => ({
    user: null,
    token: initialToken,
    isLoading: Boolean(initialToken),
    isAuthenticated: false,

    login: async (account, password) => {
        const res = await api.login({ account, password });
        const { token, user } = res.data;
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
        try {
            await runLocalDataMigration(user.id);
        } catch (error) {
            console.error('[Migration] Failed after login', error);
        }
        set({ user, token, isAuthenticated: true });
    },

    register: async (account, password, inviteCode) => {
        const res = await api.register({ account, password, inviteCode });
        const { token, user } = res.data;
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
        try {
            await runLocalDataMigration(user.id);
        } catch (error) {
            console.error('[Migration] Failed after register', error);
        }
        set({ user, token, isAuthenticated: true });
    },

    logout: async () => {
        try {
            if (readStoredToken()) {
                await api.logout();
            }
        } catch (error) {
            console.error('[Auth] Failed to revoke server session during logout', error);
        }
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        set({ user: null, token: null, isAuthenticated: false });
        window.location.href = '/login';
    },

    loadUser: async () => {
        const token = readStoredToken();
        if (!token) {
            set({ user: null, token: null, isLoading: false, isAuthenticated: false });
            return;
        }

        // Stored profile data is not an authority for model permissions.
        set({ user: null, token, isAuthenticated: false, isLoading: true });

        try {
            const res = await api.getMe();
            const user = res.data;
            try {
                await runLocalDataMigration(user.id);
            } catch (error) {
                console.error('[Migration] Failed during user load', error);
            }
            localStorage.setItem('user', JSON.stringify(user));
            set({ user, token, isAuthenticated: true, isLoading: false });
        } catch {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            set({ user: null, token: null, isLoading: false, isAuthenticated: false });
        }
    },
}));
