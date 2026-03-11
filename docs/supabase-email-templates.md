# Supabase Email Templates — Fiber Commons

## Setup Instructions

1. Go to **Supabase Dashboard** → your Commons project
2. **Authentication → URL Configuration**:
   - Site URL: `https://commons.joinfiber.app`
   - Redirect URLs: add `https://commons.joinfiber.app`
3. **Authentication → Email Templates** → paste each template below

---

## 1. Confirm Signup

Subject: `Your Fiber Commons code`

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Fiber Commons code</title>
</head>
<body style="margin:0;padding:0;background-color:#0f0f0e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0f0f0e;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;">

          <!-- Header -->
          <tr>
            <td style="padding:0 0 32px 0;">
              <span style="font-size:13px;font-weight:300;letter-spacing:0.12em;text-transform:uppercase;color:#D4A853;">fiber commons</span>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:#181715;border:1px solid #2a2825;border-radius:14px;padding:32px 28px;">

              <p style="margin:0 0 8px 0;font-size:20px;font-weight:300;color:#f5f0e8;letter-spacing:0.02em;">
                Welcome to Fiber
              </p>
              <p style="margin:0 0 28px 0;font-size:14px;color:#7a7670;line-height:1.5;">
                Enter this code to verify your email and finish creating your account.
              </p>

              <!-- OTP Code -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="background-color:#0f0f0e;border:1px solid #2a2825;border-radius:10px;padding:20px 16px;">
                    <span style="font-size:32px;font-weight:500;letter-spacing:10px;font-family:'Courier New',Courier,monospace;color:#f5f0e8;">{{ .Token }}</span>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 0 0;font-size:12px;color:#4a4740;line-height:1.5;">
                This code expires in 1 hour. If you didn't sign up for Fiber Commons, you can safely ignore this email.
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 0 0 0;text-align:center;">
              <p style="margin:0;font-size:11px;color:#4a4740;line-height:1.5;">
                Fiber Commons — open event data for your neighborhood
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

---

## 2. Magic Link (OTP Sign-In)

Subject: `Your sign-in code`

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your sign-in code</title>
</head>
<body style="margin:0;padding:0;background-color:#0f0f0e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0f0f0e;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;">

          <!-- Header -->
          <tr>
            <td style="padding:0 0 32px 0;">
              <span style="font-size:13px;font-weight:300;letter-spacing:0.12em;text-transform:uppercase;color:#D4A853;">fiber commons</span>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:#181715;border:1px solid #2a2825;border-radius:14px;padding:32px 28px;">

              <p style="margin:0 0 8px 0;font-size:20px;font-weight:300;color:#f5f0e8;letter-spacing:0.02em;">
                Sign in to Fiber
              </p>
              <p style="margin:0 0 28px 0;font-size:14px;color:#7a7670;line-height:1.5;">
                Enter this code in the sign-in screen to continue.
              </p>

              <!-- OTP Code -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="background-color:#0f0f0e;border:1px solid #2a2825;border-radius:10px;padding:20px 16px;">
                    <span style="font-size:32px;font-weight:500;letter-spacing:10px;font-family:'Courier New',Courier,monospace;color:#f5f0e8;">{{ .Token }}</span>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 0 0;font-size:12px;color:#4a4740;line-height:1.5;">
                This code expires in 1 hour. If you didn't request this, you can safely ignore this email.
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 0 0 0;text-align:center;">
              <p style="margin:0;font-size:11px;color:#4a4740;line-height:1.5;">
                Fiber Commons — open event data for your neighborhood
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

---

## 3. Change Email Address

Subject: `Confirm your new email`

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm your new email</title>
</head>
<body style="margin:0;padding:0;background-color:#0f0f0e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0f0f0e;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;">

          <!-- Header -->
          <tr>
            <td style="padding:0 0 32px 0;">
              <span style="font-size:13px;font-weight:300;letter-spacing:0.12em;text-transform:uppercase;color:#D4A853;">fiber commons</span>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:#181715;border:1px solid #2a2825;border-radius:14px;padding:32px 28px;">

              <p style="margin:0 0 8px 0;font-size:20px;font-weight:300;color:#f5f0e8;letter-spacing:0.02em;">
                Confirm email change
              </p>
              <p style="margin:0 0 28px 0;font-size:14px;color:#7a7670;line-height:1.5;">
                Enter this code to confirm your new email address.
              </p>

              <!-- OTP Code -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="background-color:#0f0f0e;border:1px solid #2a2825;border-radius:10px;padding:20px 16px;">
                    <span style="font-size:32px;font-weight:500;letter-spacing:10px;font-family:'Courier New',Courier,monospace;color:#f5f0e8;">{{ .Token }}</span>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 0 0;font-size:12px;color:#4a4740;line-height:1.5;">
                If you didn't request this change, please ignore this email or contact support.
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 0 0 0;text-align:center;">
              <p style="margin:0;font-size:11px;color:#4a4740;line-height:1.5;">
                Fiber Commons — open event data for your neighborhood
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

---

## 4. Reset Password

Subject: `Reset your password`

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset your password</title>
</head>
<body style="margin:0;padding:0;background-color:#0f0f0e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0f0f0e;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;">

          <!-- Header -->
          <tr>
            <td style="padding:0 0 32px 0;">
              <span style="font-size:13px;font-weight:300;letter-spacing:0.12em;text-transform:uppercase;color:#D4A853;">fiber commons</span>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:#181715;border:1px solid #2a2825;border-radius:14px;padding:32px 28px;">

              <p style="margin:0 0 8px 0;font-size:20px;font-weight:300;color:#f5f0e8;letter-spacing:0.02em;">
                Reset your password
              </p>
              <p style="margin:0 0 28px 0;font-size:14px;color:#7a7670;line-height:1.5;">
                Enter this code to reset your password.
              </p>

              <!-- OTP Code -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="background-color:#0f0f0e;border:1px solid #2a2825;border-radius:10px;padding:20px 16px;">
                    <span style="font-size:32px;font-weight:500;letter-spacing:10px;font-family:'Courier New',Courier,monospace;color:#f5f0e8;">{{ .Token }}</span>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 0 0;font-size:12px;color:#4a4740;line-height:1.5;">
                This code expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 0 0 0;text-align:center;">
              <p style="margin:0;font-size:11px;color:#4a4740;line-height:1.5;">
                Fiber Commons — open event data for your neighborhood
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```
