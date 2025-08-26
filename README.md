# PDF Translator

A professional web application for translating PDF documents using OpenAI's GPT models, specialized for relational psychoanalysis and academic texts.

## Features

- **PDF Upload**: Drag & drop or browse PDFs up to 25MB
- **AI Translation**: Multiple OpenAI models (GPT-4, GPT-4o, GPT-3.5 Turbo)
- **Specialized Terminology**: Built-in glossary for psychoanalytic terms
- **DOCX Output**: Clean, formatted Word documents
- **Progress Tracking**: Real-time translation progress
- **Payment Integration**: Stripe-powered donation system
- **File Security**: Automatic cleanup after 24 hours
- **Rate Limiting**: Protection against abuse

## Tech Stack

- **Frontend**: Next.js 13+ with App Router, TypeScript, Tailwind CSS
- **UI Components**: shadcn/ui with Radix UI primitives
- **PDF Processing**: pdf-parse for text extraction
- **Document Generation**: docx library for DOCX creation
- **AI Translation**: OpenAI API
- **Payments**: Stripe Checkout
- **Deployment**: Vercel/Netlify compatible

## Setup Instructions

### 1. Environment Variables

Copy `.env.example` to `.env.local` and fill in your values:

```bash
cp .env.example .env.local
```

Required environment variables:

```env
# OpenAI Configuration
OPENAI_API_KEY=sk-...your_openai_api_key

# Stripe Configuration (Test Mode)
STRIPE_SECRET_KEY=sk_test_...your_stripe_secret_key
STRIPE_PUBLISHABLE_KEY=pk_test_...your_stripe_publishable_key
STRIPE_PRICE_ID_3=price_...your_3usd_price_id
STRIPE_PRICE_ID_5=price_...your_5usd_price_id
STRIPE_PRICE_ID_10=price_...your_10usd_price_id

# Optional
DONATION_LINK=https://ko-fi.com/yourusername
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### 2. OpenAI Setup

1. Get your API key from [OpenAI Platform](https://platform.openai.com/api-keys)
2. Ensure you have sufficient credits for your expected usage
3. The app uses GPT-4o-mini by default (most cost-effective)

### 3. Stripe Setup (Optional)

For donation functionality:

1. Create a [Stripe account](https://dashboard.stripe.com/register)
2. Get your test mode keys from the [Developers section](https://dashboard.stripe.com/test/apikeys)
3. Create products with fixed prices ($3, $5, $10) or use dynamic pricing
4. Add the price IDs to your environment variables

### 4. Installation & Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

### 5. File Cleanup

The app automatically stores files in the `/temp` directory and requires cleanup. Set up a cron job or scheduled function to call the cleanup endpoint:

```bash
# Example cron job (runs daily at 2 AM)
0 2 * * * curl -X POST -H "Authorization: Bearer cleanup-secret" http://localhost:3000/api/cleanup
```

## Usage

1. **Upload PDF**: Drag and drop or select a PDF file (max 25MB)
2. **Select Languages**: Choose source and target languages
3. **Choose Model**: Select an OpenAI model based on quality/cost needs
4. **Translate**: Click "Translate Document" and monitor progress
5. **Download**: Download the translated DOCX file
6. **Support** (Optional): Make a donation to support development

## API Endpoints

- `POST /api/upload` - Upload PDF file
- `POST /api/translate` - Translate document (Server-Sent Events)
- `GET /api/download` - Download translated DOCX
- `POST /api/create-checkout` - Create Stripe payment session
- `POST /api/cleanup` - Clean up old files (requires auth)

## Deployment

### Vercel (Recommended)

1. Push to GitHub repository
2. Connect to Vercel
3. Add environment variables in Vercel dashboard
4. Deploy

### Netlify

1. Build the static site: `npm run build`
2. Deploy the `out` folder to Netlify
3. Add environment variables in Netlify dashboard

### Docker

```bash
# Build image
docker build -t pdf-translator .

# Run container
docker run -p 3000:3000 --env-file .env.local pdf-translator
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Commit changes: `git commit -am 'Add feature'`
4. Push to branch: `git push origin feature-name`
5. Submit a Pull Request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:
- Email: support@pdftranslator.com
- GitHub Issues: [Create an issue](https://github.com/yourusername/pdf-translator/issues)

## Privacy & Security

- Files are automatically deleted after 24 hours
- No permanent storage of user documents
- OpenAI API calls are server-side only
- Rate limiting prevents abuse
- Stripe handles all payment processing securely