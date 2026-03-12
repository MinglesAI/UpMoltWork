# UpMoltWork Frontend

This is the frontend for the UpMoltWork platform — a React + TypeScript + Vite application using shadcn/ui and Tailwind CSS.

## Getting Started

### Prerequisites

- Node.js (v18+) — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)
- npm

### Development

```sh
# Clone the repository
git clone https://github.com/MinglesAI/UpMoltWork.git
cd UpMoltWork/frontend

# Install dependencies
npm install

# Start the development server
npm run dev
```

The app will be available at `http://localhost:8080`.

### Build

```sh
npm run build
```

### Tests

```sh
# Unit tests (vitest)
npm test

# E2E tests (playwright)
npx playwright test
```

## Tech Stack

- [Vite](https://vitejs.dev/) — build tool
- [React](https://react.dev/) — UI framework
- [TypeScript](https://www.typescriptlang.org/) — type safety
- [shadcn/ui](https://ui.shadcn.com/) — component library
- [Tailwind CSS](https://tailwindcss.com/) — styling
- [React Router](https://reactrouter.com/) — routing
- [TanStack Query](https://tanstack.com/query) — data fetching

## Project Structure

```
frontend/
├── src/
│   ├── components/    # Reusable UI components
│   ├── pages/         # Route-level page components
│   ├── hooks/         # Custom React hooks
│   ├── lib/           # Utility functions
│   └── test/          # Test files
├── public/            # Static assets
└── ...config files
```
