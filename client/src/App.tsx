import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import AstraPlatform from "@/pages/AstraPlatform";
import { AuthCallbackPage, ForgotPasswordPage, GuestOnly, LoginPage, RequireAuth, ResetPasswordPage, SignupPage } from "@/pages/AuthPages";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { AuthProvider } from "./contexts/AuthContext";
import { ThemeProvider } from "./contexts/ThemeContext";

function Router() {
  return (
    <Switch>
      <Route path="/login"><GuestOnly><LoginPage /></GuestOnly></Route>
      <Route path="/signup"><GuestOnly><SignupPage /></GuestOnly></Route>
      <Route path="/forgot-password"><GuestOnly><ForgotPasswordPage /></GuestOnly></Route>
      <Route path="/reset-password"><ResetPasswordPage /></Route>
      <Route path="/auth/callback"><AuthCallbackPage /></Route>
      {/* Every other path is the authenticated ASTRA application (it dispatches its own sub-routes). */}
      <Route><RequireAuth><AstraPlatform /></RequireAuth></Route>
    </Switch>
  );
}

function App() {
  return <ErrorBoundary><ThemeProvider defaultTheme="dark"><TooltipProvider><AuthProvider><Toaster theme="dark" /><Router /></AuthProvider></TooltipProvider></ThemeProvider></ErrorBoundary>;
}

export default App;
