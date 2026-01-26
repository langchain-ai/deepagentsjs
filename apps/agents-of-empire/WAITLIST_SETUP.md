# Waitlist Email Service Setup Guide

This guide explains how to configure the email service for the Agents of Empire waitlist functionality.

## Overview

The waitlist feature uses **Resend** - a modern email API service that provides:
- 3,000 free emails per month
- Simple REST API integration
- TypeScript support
- No backend required (works directly from the frontend)

## Quick Setup

### 1. Create a Resend Account

1. Go to [https://resend.com/](https://resend.com/)
2. Sign up for a free account
3. Verify your email address

### 2. Get Your API Key

1. Navigate to [https://resend.com/api-keys](https://resend.com/api-keys)
2. Click "Create API Key"
3. Give it a name like "Agents of Empire Waitlist"
4. Copy the API key (starts with `re_`)

### 3. Configure Environment Variables

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Fill in your values:
   ```env
   VITE_RESEND_API_KEY=re_your_actual_api_key_here
   VITE_WAITLIST_FROM_EMAIL=onboarding@resend.dev
   VITE_WAITLIST_TO_EMAIL=your-email@example.com
   ```

### 4. Test the Integration

1. Start the development server:
   ```bash
   pnpm dev
   ```

2. Navigate to the landing page
3. Click "Join Waitlist"
4. Enter an email address and submit
5. Check the destination email for the waitlist notification

## Using Your Own Domain

For production, you'll want to use your own domain instead of `@resend.dev`:

### 1. Verify Your Domain

1. Go to [https://resend.com/domains](https://resend.com/domains)
2. Click "Add Domain"
3. Enter your domain (e.g., `agentsofempire.org`)
4. Add the DNS records shown to your domain's DNS settings
5. Wait for verification (can take up to 24 hours)

### 2. Update Environment Variables

Once verified, update your `.env`:
```env
VITE_WAITLIST_FROM_EMAIL=noreply@agentsofempire.org
VITE_WAITLIST_TO_EMAIL=waitlist@agentsofempire.org
```

## Advanced: Using Resend Contacts API

For better email list management, you can use Resend's Contacts API:

### 1. Create an Audience

1. Go to [https://resend.com/audiences](https://resend.com/audiences)
2. Click "Create Audience"
3. Give it a name like "Agents of Empire Waitlist"
4. Copy the Audience ID

### 2. Update Configuration

Add to your `.env`:
```env
VITE_RESEND_AUDIENCE_ID=your-audience-id-here
```

This will add emails directly to your Resend audience for easier management.

## Demo Mode

If no API key is configured, the waitlist runs in **demo mode**:
- Simulates API calls with a delay
- Shows success without sending real emails
- Displays a warning banner on the form
- Useful for development and testing

## How It Works

The waitlist submission flow:

1. **Frontend Validation**: Email format is validated client-side
2. **API Call**: `POST` request to Resend's email API
3. **Success Response**: Confirmation modal with celebration animation
4. **Error Handling**: User-friendly error messages for failures
5. **Loading States**: Visual feedback during submission

## Security Notes

- **API Key Exposure**: The Resend API key is client-side accessible. This is acceptable for waitlist signups because:
  - The key only has permission to send emails
  - Rate limiting protects against abuse
  - Each submission requires a valid email

- **Rate Limits**: Resend enforces rate limits to prevent abuse

- **GDPR Compliance**: Consider adding:
  - Checkbox for consent
  - Link to privacy policy
  - Unsubscribe mechanism

## Troubleshooting

### "Demo Mode" warning appears

**Solution**: Add your `VITE_RESEND_API_KEY` to `.env` and restart the dev server.

### "API Error" message

**Possible causes**:
- Invalid API key
- Unverified domain (if using custom domain)
- Rate limit exceeded

**Solution**: Check the browser console for detailed error messages.

### No email received

**Possible causes**:
- Wrong `VITE_WAITLIST_TO_EMAIL` address
- Email in spam folder
- Delivery delay (usually instant, but can take up to a few minutes)

## Alternative Email Services

If you prefer not to use Resend, you can adapt the `waitlistService.ts` to work with:

- **SendGrid**: Similar API structure, transactional email focus
- **Mailchimp**: Use their API to add subscribers directly
- **ConvertKit**: Creator-focused, good for newsletters
- **Buttondown**: Simple, developer-friendly newsletter service

To switch, modify `src/landing/waitlistService.ts` to use the chosen provider's API.

## Support

- Resend Documentation: [https://resend.com/docs](https://resend.com/docs)
- Resend API Reference: [https://resend.com/docs/api-reference](https://resend.com/docs/api-reference)
- GitHub Issues: [https://github.com/DavinciDreams/deepagentsjs/issues](https://github.com/DavinciDreams/deepagentsjs/issues)
