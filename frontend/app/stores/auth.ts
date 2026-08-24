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

function readStoredUser(): UserInfo | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = localStorage.getItem('user');
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') {
            return null;
        }
        return parsed as UserInfo;
    } catch {
        return null;
    }
}

const initialToken = readStoredToken();
const initialUser = initialToken ? readStoredUser() : null;

export const useAuthStore = create<AuthState>((set) => ({
    user: initialUser,
    token: initialToken,
    isLoading: Boolean(initialToken && !initialUser),
    isAuthenticated: Boolean(initialToken && initialUser),

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

        const cachedUser = readStoredUser();
        if (cachedUser) {
            set({ user: cachedUser, token, isAuthenticated: true, isLoading: false });
        } else {
            set((state) => ({ ...state, token, isLoading: true }));
        }

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
            set({ isLoading: false, isAuthenticated: false });
        }
    },
}));
