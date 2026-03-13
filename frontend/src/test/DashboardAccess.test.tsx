import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DashboardAccess, { getDashboardToken, setDashboardToken, clearDashboardToken } from '../components/dashboard/DashboardAccess';

const TEST_AGENT_ID = 'agt_test1234';

function renderWithRouter(agentId: string, search = '') {
  return render(
    <MemoryRouter initialEntries={[`/dashboard/${agentId}${search}`]}>
      <Routes>
        <Route
          path="/dashboard/:agentId"
          element={
            <DashboardAccess>
              <div data-testid="dashboard-content">Dashboard Content</div>
            </DashboardAccess>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DashboardAccess', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('renders AccessDenied when no token in URL or sessionStorage', () => {
    renderWithRouter(TEST_AGENT_ID);
    expect(screen.getByText('Access Denied')).toBeTruthy();
    expect(screen.queryByTestId('dashboard-content')).toBeNull();
  });

  it('renders children when token is stored in sessionStorage', () => {
    // Set a fake non-expired token (exp far in future)
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const fakePayload = btoa(JSON.stringify({ sub: TEST_AGENT_ID, type: 'view', exp }));
    const fakeToken = `header.${fakePayload}.signature`;
    setDashboardToken(TEST_AGENT_ID, fakeToken);

    renderWithRouter(TEST_AGENT_ID);
    expect(screen.getByTestId('dashboard-content')).toBeTruthy();
  });

  it('shows AccessDenied when stored token is expired', () => {
    // Set a token with exp in the past
    const exp = Math.floor(Date.now() / 1000) - 100;
    const fakePayload = btoa(JSON.stringify({ sub: TEST_AGENT_ID, type: 'view', exp }));
    const fakeToken = `header.${fakePayload}.signature`;
    setDashboardToken(TEST_AGENT_ID, fakeToken);

    renderWithRouter(TEST_AGENT_ID);
    expect(screen.getByText('Access Denied')).toBeTruthy();
  });

  it('getDashboardToken returns null when nothing stored', () => {
    expect(getDashboardToken(TEST_AGENT_ID)).toBeNull();
  });

  it('setDashboardToken and getDashboardToken work together', () => {
    setDashboardToken(TEST_AGENT_ID, 'my-token');
    expect(getDashboardToken(TEST_AGENT_ID)).toBe('my-token');
    clearDashboardToken(TEST_AGENT_ID);
    expect(getDashboardToken(TEST_AGENT_ID)).toBeNull();
  });
});
