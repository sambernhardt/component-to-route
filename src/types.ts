export type Confidence = 'high' | 'medium' | 'low';

export type RouteReason =
  | 'direct-page-usage'
  | 'shared-layout'
  | 'shared-template'
  | 'global-wrapper';

export type RouteKind =
  | 'app-page'
  | 'app-layout'
  | 'app-template'
  | 'pages-page'
  | 'pages-app';

export interface SymbolRef {
  key: string;
  name: string;
  filePath: string;
}

export interface StackFrame {
  filePath: string;
  symbolName: string;
}

export interface RouteMatch {
  route: string;
  entryFile: string;
  stack: StackFrame[];
  symbols: string[];
  confidence: Confidence;
  confidenceScore: number;
  notes: string[];
  qaReason: RouteReason;
}

export interface AnalyzeOptions {
  workspaceRoot: string;
  appRoot: string;
  componentPath: string;
  exportName?: string;
  useCache: boolean;
  useBuildArtifacts: boolean;
  followDynamicImports: boolean;
  cacheDir: string;
}

export interface ComponentToRouteResult {
  appRoot: string;
  workspaceRoot: string;
  componentPath: string;
  exportName?: string;
  targetSymbols: SymbolRef[];
  routes: RouteMatch[];
  buildArtifactsUsed: boolean;
  cacheUsed: boolean;
}

export interface RouteFile {
  filePath: string;
  route: string;
  kind: RouteKind;
  routeGroupPath: string;
}

export interface BuildArtifactsInfo {
  builtRoutes: Set<string>;
  manifests: string[];
}

export interface CachedAnalysis {
  cacheVersion: number;
  appRoot: string;
  componentPath: string;
  exportName?: string;
  fingerprint: string;
  result: ComponentToRouteResult;
}
