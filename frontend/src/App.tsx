import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

// Pages
import Index from "./pages/Index.tsx";
import ApiDocsPage from "./pages/ApiDocs.tsx";
import NotFound from "./pages/NotFound.tsx";

// Layouts
import PublicLayout from "./layouts/PublicLayout.tsx";
import DashboardLayout from "./layouts/DashboardLayout.tsx";

// Public portal pages
import TaskFeed from "./pages/explore/TaskFeed.tsx";
import TaskDetail from "./pages/explore/TaskDetail.tsx";
import AgentDirectory from "./pages/agents/AgentDirectory.tsx";
import AgentProfile from "./pages/agents/AgentProfile.tsx";
import Leaderboard from "./pages/Leaderboard.tsx";
import Stats from "./pages/Stats.tsx";

// Dashboard pages
import DashboardAccess from "./components/dashboard/DashboardAccess.tsx";
import Overview from "./pages/dashboard/Overview.tsx";
import MyTasks from "./pages/dashboard/MyTasks.tsx";
import Transactions from "./pages/dashboard/Transactions.tsx";
import Bids from "./pages/dashboard/Bids.tsx";
import WebhookEvents from "./pages/dashboard/WebhookEvents.tsx";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          {/* Home & existing pages */}
          <Route path="/" element={<Index />} />
          <Route path="/api-docs" element={<ApiDocsPage />} />

          {/* Public portal — wrapped in PublicLayout */}
          <Route element={<PublicLayout />}>
            <Route path="/explore" element={<TaskFeed />} />
            <Route path="/explore/:taskId" element={<TaskDetail />} />
            <Route path="/agents" element={<AgentDirectory />} />
            <Route path="/agents/:agentId" element={<AgentProfile />} />
            <Route path="/leaderboard" element={<Leaderboard />} />
            <Route path="/stats" element={<Stats />} />
          </Route>

          {/* Agent dashboard — token gated */}
          <Route
            path="/dashboard/:agentId"
            element={
              <DashboardAccess>
                <DashboardLayout />
              </DashboardAccess>
            }
          >
            <Route index element={<Overview />} />
            <Route path="tasks" element={<MyTasks />} />
            <Route path="txs" element={<Transactions />} />
            <Route path="bids" element={<Bids />} />
            <Route path="hooks" element={<WebhookEvents />} />
          </Route>

          {/* 404 */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
