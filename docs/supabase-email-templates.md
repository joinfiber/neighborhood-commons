# Supabase Email Templates — Neighborhood Commons

## Setup Instructions

1. Go to **Supabase Dashboard** → your Commons project
2. **Authentication → URL Configuration**:
   - Site URL: `https://api.neighborhood-commons.org/portal`
   - Redirect URLs: add `https://api.neighborhood-commons.org/portal`
3. **Authentication → Email Templates** → paste each template below

---

## 1. Confirm Signup

Subject: `Sign in to Neighborhood Commons`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <title>Sign in to Neighborhood Commons</title>
</head>
<body style="margin:0;padding:0;background-color:#0f0f0e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0f0f0e;">
    <tr>
      <td align="center" style="padding:64px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;">

          <!-- Header -->
          <tr>
            <td style="padding:0 0 40px 0;">
              <span style="font-size:13px;font-weight:300;letter-spacing:0.12em;text-transform:uppercase;color:#D4A853;">neighborhood commons</span>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:#181715;border:1px solid #2a2825;border-radius:14px;padding:32px 28px;">

              <p style="margin:0 0 8px 0;font-size:20px;font-weight:300;color:#f5f0e8;letter-spacing:0.02em;">
                Welcome to Neighborhood Commons
              </p>
              <p style="margin:0 0 28px 0;font-size:14px;color:#7a7670;line-height:1.5;">
                Tap the button below to sign in and finish creating your account.
              </p>

              <!-- CTA Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:4px 0;">
                    <a href="{{ .ConfirmationURL }}" target="_blank" style="display:inline-block;padding:14px 40px;font-size:15px;font-weight:500;color:#0f0f0e;background:#f5f0e8;border-radius:8px;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Sign in to Neighborhood Commons</a>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 0 0;font-size:12px;color:#4a4740;line-height:1.5;">
                If you didn't sign up for Neighborhood Commons, you can safely ignore this email.
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 0 0 0;text-align:center;">
              <p style="margin:0;font-size:11px;color:#4a4740;line-height:1.5;">
                Neighborhood Commons — open event data for your neighborhood
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

## 2. Magic Link (Sign-In)

Subject: `Sign in to Neighborhood Commons`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <title>Sign in to Neighborhood Commons</title>
</head>
<body style="margin:0;padding:0;background-color:#0f0f0e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0f0f0e;">
    <tr>
      <td align="center" style="padding:64px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;">

          <!-- Header -->
          <tr>
            <td style="padding:0 0 40px 0;">
              <span style="font-size:13px;font-weight:300;letter-spacing:0.12em;text-transform:uppercase;color:#D4A853;">neighborhood commons</span>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:#181715;border:1px solid #2a2825;border-radius:14px;padding:32px 28px;">

              <p style="margin:0 0 8px 0;font-size:20px;font-weight:300;color:#f5f0e8;letter-spacing:0.02em;">
                Sign in to Neighborhood Commons
              </p>
              <p style="margin:0 0 28px 0;font-size:14px;color:#7a7670;line-height:1.5;">
                Tap the button below to sign in.
              </p>

              <!-- CTA Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:4px 0;">
                    <a href="{{ .ConfirmationURL }}" target="_blank" style="display:inline-block;padding:14px 40px;font-size:15px;font-weight:500;color:#0f0f0e;background:#f5f0e8;border-radius:8px;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Sign in to Neighborhood Commons</a>
                  </td>
                </tr>
              </table>

              <!-- Fallback -->
              <p style="margin:20px 0 0 0;font-size:11px;color:#4a4740;line-height:1.5;text-align:center;">
                Button not working? Copy and paste this link:<br>
                <span style="color:#706d6a;word-break:break-all;">{{ .ConfirmationURL }}</span>
              </p>

              <p style="margin:20px 0 0 0;font-size:12px;color:#4a4740;line-height:1.5;">
                This link expires in 1 hour. If you didn't request this, you can safely ignore this email.
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 0 0 0;text-align:center;">
              <p style="margin:0;font-size:11px;color:#4a4740;line-height:1.5;">
                Neighborhood Commons — open event data for your neighborhood
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
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <title>Confirm your new email</title>
</head>
<body style="margin:0;padding:0;background-color:#0f0f0e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0f0f0e;">
    <tr>
      <td align="center" style="padding:64px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;">

          <!-- Header -->
          <tr>
            <td style="padding:0 0 40px 0;">
              <span style="font-size:13px;font-weight:300;letter-spacing:0.12em;text-transform:uppercase;color:#D4A853;">neighborhood commons</span>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:#181715;border:1px solid #2a2825;border-radius:14px;padding:32px 28px;">

              <p style="margin:0 0 8px 0;font-size:20px;font-weight:300;color:#f5f0e8;letter-spacing:0.02em;">
                Confirm email change
              </p>
              <p style="margin:0 0 28px 0;font-size:14px;color:#7a7670;line-height:1.5;">
                Tap the button below to confirm your new email address.
              </p>

              <!-- CTA Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:4px 0;">
                    <a href="{{ .ConfirmationURL }}" target="_blank" style="display:inline-block;padding:14px 40px;font-size:15px;font-weight:500;color:#0f0f0e;background:#f5f0e8;border-radius:8px;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Confirm new email</a>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 0 0;font-size:12px;color:#4a4740;line-height:1.5;">
                If you didn't request this change, please ignore this email.
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 0 0 0;text-align:center;">
              <p style="margin:0;font-size:11px;color:#4a4740;line-height:1.5;">
                Neighborhood Commons — open event data for your neighborhood
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
