# CloudVault Backend

The CloudVault backend provides the server-side APIs, authentication integration, database operations and cloud-storage functionality used by the CloudVault frontend.

## Backend Stack

- Node.js
- TypeScript
- Supabase
- PostgreSQL
- Vercel Serverless Functions
- REST APIs

## Backend Components

### api/

Contains server/API endpoints used by the CloudVault application.

### server/

Contains server-side application logic and backend services.

### supabase/

Contains Supabase-related database configuration, migrations and backend resources.

### data/

Contains application data and backend data-related resources.

### scripts/

Contains development, database and deployment utility scripts.

## Backend Responsibilities

- Authentication integration
- User account operations
- Database operations
- File metadata management
- Folder management
- File operations
- Sharing
- Storage management
- Trash operations
- Starred files
- Recent files
- Search
- Activity tracking
- Server-side validation
- Secure API operations

## Security

The backend must keep sensitive credentials server-side.

The following must never be exposed to browser/client-side code:

SUPABASE_SERVICE_ROLE_KEY

SMTP credentials

Database passwords

POSTGRES credentials

Other private server secrets

Frontend authentication uses the public Supabase client configuration.

## Environment Variables

Server-side environment variables include the required Supabase, database and SMTP configuration.

Never commit real secret values to GitHub.

Use `.env.example` to document required variables without exposing secrets.

## Deployment

The backend/API is deployed as part of the CloudVault Vercel deployment.

Production:

https://cloud-vault-azure-chi.vercel.app
