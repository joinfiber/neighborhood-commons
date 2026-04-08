import { useState, useEffect, useCallback } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { checkPortalEmail, registerAccount, type UserRole } from '../lib/api';

interface AuthState {
  user: User | null;
  session: Session | null;
  initializing: boolean;
  loading: boolean;
  error: string | null;
  preAuthRole: UserRole | null;
  /** True when check-email returned canSignUp (unknown email) */
  canSignUp: boolean;
  /** True after magic link email was sent (show "check your email" screen) */
  magicLinkSent: boolean;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    session: null,
    initializing: true,
    loading: false,
    error: null,
    preAuthRole: null,
    canSignUp: false,
    magicLinkSent: false,
  });

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session }, error }) => {
      setState({
        user: session?.user ?? null,
        session,
        initializing: false,
        loading: false,
        error: error?.message ?? null,
        preAuthRole: null,
        canSignUp: false,
        magicLinkSent: false,
      });
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setState((prev) => ({
        ...prev,
        user: session?.user ?? null,
        session,
        loading: false,
        magicLinkSent: false,
      }));
    });

    return () => subscription.unsubscribe();
  }, []);

  /**
   * Check email and send magic link (known user) or signal canSignUp (new user).
   * Returns 'magic_link_sent' | 'needs_signup' | 'error'.
   */
  const signIn = useCallback(async (email: string): Promise<'magic_link_sent' | 'needs_signup' | 'error'> => {
    setState((prev) => ({ ...prev, loading: true, error: null, canSignUp: false, magicLinkSent: false }));

    const emailCheck = await checkPortalEmail(email);

    // Unknown email — allow self-signup
    if (emailCheck.canSignUp) {
      setState((prev) => ({ ...prev, loading: false, canSignUp: true }));
      return 'needs_signup';
    }

    if (!emailCheck.allowed) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: emailCheck.error || 'No portal account found for this email',
      }));
      return 'error';
    }

    // Send magic link — Supabase emails a link that redirects back to the portal
    const redirectTo = `${window.location.origin}/portal`;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    if (error) {
      setState((prev) => ({ ...prev, loading: false, error: error.message }));
      return 'error';
    }

    setState((prev) => ({ ...prev, loading: false, preAuthRole: emailCheck.role || null, magicLinkSent: true }));
    return 'magic_link_sent';
  }, []);

  /**
   * Register a new business account, then server sends magic link.
   * Returns true if magic link was sent successfully.
   */
  const register = useCallback(async (email: string, businessName: string, captchaToken: string): Promise<boolean> => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    const regResult = await registerAccount(email, businessName, captchaToken);
    if (!regResult.success) {
      setState((prev) => ({ ...prev, loading: false, error: regResult.error || 'Registration failed' }));
      return false;
    }

    // Magic link is sent server-side by the register endpoint
    setState((prev) => ({ ...prev, loading: false, canSignUp: false, preAuthRole: 'business', magicLinkSent: true }));
    return true;
  }, []);

  const signOut = useCallback(async (scope: 'local' | 'global' = 'local') => {
    await supabase.auth.signOut({ scope });
    setState({ user: null, session: null, initializing: false, loading: false, error: null, preAuthRole: null, canSignUp: false, magicLinkSent: false });
  }, []);

  /** Reset signup state (go back to email input) */
  const resetSignUp = useCallback(() => {
    setState((prev) => ({ ...prev, canSignUp: false, magicLinkSent: false, error: null }));
  }, []);

  return {
    ...state,
    signIn,
    register,
    signOut,
    resetSignUp,
    isAuthenticated: !!state.session,
  };
}
