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
      }));
    });

    return () => subscription.unsubscribe();
  }, []);

  /**
   * Check email and either send OTP (known user) or signal canSignUp (new user).
   * Returns 'otp_sent' | 'needs_signup' | 'error'.
   */
  const signIn = useCallback(async (email: string, captchaToken?: string): Promise<'otp_sent' | 'needs_signup' | 'error'> => {
    setState((prev) => ({ ...prev, loading: true, error: null, canSignUp: false }));

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

    // Pass captcha token to Supabase (matches admin app pattern)
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: captchaToken ? { captchaToken } : undefined,
    });
    if (error) {
      setState((prev) => ({ ...prev, loading: false, error: error.message }));
      return 'error';
    }

    setState((prev) => ({ ...prev, loading: false, preAuthRole: emailCheck.role || null }));
    return 'otp_sent';
  }, []);

  /**
   * Register a new business account, then send OTP.
   * Returns true if OTP was sent successfully.
   */
  const register = useCallback(async (email: string, businessName: string, captchaToken: string): Promise<boolean> => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    const regResult = await registerAccount(email, businessName, captchaToken);
    if (!regResult.success) {
      setState((prev) => ({ ...prev, loading: false, error: regResult.error || 'Registration failed' }));
      return false;
    }

    // OTP is sent server-side by the register endpoint (bypasses Supabase captcha)
    setState((prev) => ({ ...prev, loading: false, canSignUp: false, preAuthRole: 'business' }));
    return true;
  }, []);

  const verifyOtp = useCallback(async (email: string, token: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    const { error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'email',
    });

    if (error) {
      setState((prev) => ({ ...prev, loading: false, error: error.message }));
      return false;
    }

    setState((prev) => ({ ...prev, loading: false }));
    return true;
  }, []);

  const signOut = useCallback(async (scope: 'local' | 'global' = 'local') => {
    await supabase.auth.signOut({ scope });
    setState({ user: null, session: null, initializing: false, loading: false, error: null, preAuthRole: null, canSignUp: false });
  }, []);

  /** Reset signup state (go back to email input) */
  const resetSignUp = useCallback(() => {
    setState((prev) => ({ ...prev, canSignUp: false, error: null }));
  }, []);

  return {
    ...state,
    signIn,
    register,
    verifyOtp,
    signOut,
    resetSignUp,
    isAuthenticated: !!state.session,
  };
}
