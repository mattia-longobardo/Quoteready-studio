"use client";

import { DocumentsView } from "@/components/documents-view";
import { DrawingsView } from "@/components/drawings-view";
import { PartsView } from "@/components/parts-view";
import { Planner } from "@/components/planner";
import { usePlatform } from "@/components/platform-shell";
import {
  DashboardView,
  FactoryView,
  ResultsView,
  ZooLibraryView,
} from "@/components/platform-views";
import { SettingsView } from "@/components/settings-view";

export function DashboardPage() {
  const { auth, workspace, navigate } = usePlatform();
  return (
    <DashboardView auth={auth} workspace={workspace} onNavigate={navigate} />
  );
}

export function PlannerPage() {
  const { auth, workspace, loadWorkspace, plannerSeed } = usePlatform();
  return (
    <Planner
      auth={auth}
      machines={workspace.machines}
      onReport={loadWorkspace}
      parts={workspace.parts}
      seed={plannerSeed}
    />
  );
}

export function LibraryPage() {
  const { auth, workspace, planProject, navigate } = usePlatform();
  return (
    <ZooLibraryView
      auth={auth}
      settings={workspace.settings}
      onPlan={planProject}
      onLocalPlan={() => navigate("planner")}
      onNavigate={navigate}
    />
  );
}

export function PartsPage() {
  const { auth, workspace, loadWorkspace, navigate } = usePlatform();
  return (
    <PartsView
      auth={auth}
      workspace={workspace}
      refresh={loadWorkspace}
      onNavigate={navigate}
    />
  );
}

export function DrawingsPage() {
  const { auth, workspace, loadWorkspace, navigate } = usePlatform();
  return (
    <DrawingsView
      auth={auth}
      workspace={workspace}
      refresh={loadWorkspace}
      onNavigate={navigate}
    />
  );
}

export function ResultsPage() {
  const { auth, workspace, loadWorkspace, navigate } = usePlatform();
  return (
    <ResultsView
      auth={auth}
      workspace={workspace}
      refresh={loadWorkspace}
      onNavigate={navigate}
    />
  );
}

export function ReportsPage() {
  const { auth, workspace, loadWorkspace, navigate } = usePlatform();
  return (
    <DocumentsView
      auth={auth}
      workspace={workspace}
      refresh={loadWorkspace}
      onNavigate={navigate}
    />
  );
}

export function FactoryPage() {
  const { auth, workspace, loadWorkspace } = usePlatform();
  return (
    <FactoryView
      auth={auth}
      machines={workspace.machines}
      refresh={loadWorkspace}
    />
  );
}

export function SettingsPage() {
  const { workspace, loadWorkspace } = usePlatform();
  return <SettingsView settings={workspace.settings} refresh={loadWorkspace} />;
}
