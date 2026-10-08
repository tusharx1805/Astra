import { useLocation } from "wouter";

export type ModuleTab = { label: string; href: string };

export function ModuleSubnav({ tabs }: { tabs: ModuleTab[] }) {
  const [location, setLocation] = useLocation();
  return <nav className="module-subnav" aria-label="Module navigation">{tabs.map(tab => <button key={tab.href} className={location === tab.href ? "active" : ""} onClick={() => setLocation(tab.href)}>{tab.label}</button>)}</nav>;
}
