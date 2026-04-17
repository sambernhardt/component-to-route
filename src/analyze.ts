import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import fg from 'fast-glob';
import ts from 'typescript';

import { readCachedAnalysis, writeCachedAnalysis } from './cache.js';
import type {
  AnalyzeOptions,
  BuildArtifactsInfo,
  ComponentToRouteResult,
  RouteFile,
  RouteMatch,
  RouteReason,
  StackFrame,
  SymbolRef,
} from './types.js';

interface ImportBinding {
  kind: 'symbol' | 'namespace';
  sourceFile: string;
  symbolName?: string;
}

interface LocalRef {
  kind: 'local' | 'external';
  filePath?: string;
  symbolName: string;
}

interface LocalSymbol {
  name: string;
  exported: boolean;
  isComponent: boolean;
  refs: LocalRef[];
}

interface ExportDef {
  kind: 'named-local' | 'default-local' | 'named-from' | 'default-from' | 'star-from';
  exportedName?: string;
  localName?: string;
  sourceFile?: string;
  sourceSymbol?: string;
}

interface FileSummary {
  filePath: string;
  localSymbols: Map<string, LocalSymbol>;
  exportDefs: ExportDef[];
}

interface GraphNode extends SymbolRef {
  kind: 'component' | 'alias';
  edges: Set<string>;
}

interface RouteEntry {
  routeFile: RouteFile;
  startKey: string;
}

interface AppContext {
  appRoot: string;
  workspaceRoot: string;
  targetPackageRoot: string;
  pathAliases: Array<{ pattern: string; targets: string[] }>;
  packageByName: Map<string, { packageRoot: string; name: string; exports: Record<string, string> }>;
  dependencyAliasToPackageName: Map<string, string>;
}

export async function analyzeComponentRoutes(
  options: AnalyzeOptions,
): Promise<ComponentToRouteResult> {
  const appRoot = normalizePath(path.resolve(options.appRoot));
  const componentPath = normalizePath(path.resolve(options.componentPath));
  const workspaceRoot = normalizePath(options.workspaceRoot);
  const targetPackageRoot = await findPackageRoot(componentPath);

  try {
    await stat(path.join(workspaceRoot, 'package.json'));
  } catch {
    throw new Error(
      `No package.json found in current directory (${workspaceRoot}). Run component-to-route from your workspace root.`,
    );
  }
  const cacheKey = stableHash(`${appRoot}:${componentPath}:${options.exportName ?? ''}`);
  const fingerprint = await buildFingerprint(
    appRoot,
    workspaceRoot,
    componentPath,
    options.exportName,
  );

  if (options.useCache) {
    const cached = await readCachedAnalysis(options.cacheDir, cacheKey);
    if (cached && cached.fingerprint === fingerprint) {
      return {
        ...cached.result,
        cacheUsed: true,
      };
    }
  }

  const context = await buildContext(appRoot, workspaceRoot, targetPackageRoot);
  const analysisFiles = await collectAnalysisFiles(appRoot, targetPackageRoot, componentPath);
  const summaries = await parseFiles(analysisFiles, context, {
    followDynamicImports: options.followDynamicImports,
  });
  const graph = buildGraph(summaries);

  const targetSummary = summaries.get(componentPath);
  if (!targetSummary) {
    throw new Error(`Could not load target component file: ${componentPath}`);
  }

  const targetKeys = resolveTargetKeys(targetSummary, options.exportName);

  if (targetKeys.length === 0) {
    const qualifier = options.exportName
      ? ` matching export "${options.exportName}"`
      : '';
    throw new Error(
      `Could not find exported component symbols${qualifier} in target file: ${componentPath}`,
    );
  }

  const routeInventory = await buildRouteInventory(appRoot);
  const routeEntries = collectRouteEntries(routeInventory.all, summaries, graph);
  const buildArtifacts = options.useBuildArtifacts
    ? await readBuildArtifacts(appRoot)
    : null;
  const routes = resolveRoutes(routeInventory, routeEntries, targetKeys, graph, buildArtifacts);

  const result: ComponentToRouteResult = {
    appRoot,
    workspaceRoot,
    componentPath,
    exportName: options.exportName,
    targetSymbols: targetKeys
      .map((key) => graph.get(key))
      .filter((node): node is GraphNode => Boolean(node))
      .map((node) => ({ key: node.key, name: node.name, filePath: node.filePath })),
    routes,
    buildArtifactsUsed: Boolean(buildArtifacts && buildArtifacts.manifests.length > 0),
    cacheUsed: false,
  };

  if (options.useCache) {
    await writeCachedAnalysis(options.cacheDir, cacheKey, {
      appRoot,
      componentPath,
      exportName: options.exportName,
      fingerprint,
      result,
    });
  }

  return result;
}

async function buildContext(
  appRoot: string,
  workspaceRoot: string,
  targetPackageRoot: string,
): Promise<AppContext> {
  const tsconfig = readTsConfig(appRoot);
  const appPackage = await readJsonFile<Record<string, unknown>>(path.join(appRoot, 'package.json'));
  const packageFiles = await fg(`${normalizeGlob(path.join(workspaceRoot, 'packages'))}/**/package.json`, {
    absolute: true,
    onlyFiles: true,
    ignore: ['**/node_modules/**'],
  });

  const packageByName = new Map<string, { packageRoot: string; name: string; exports: Record<string, string> }>();
  for (const packageFile of packageFiles) {
    const pkg = await readJsonFile<Record<string, unknown>>(packageFile);
    const name = typeof pkg.name === 'string' ? pkg.name : null;
    if (!name) continue;

    const exportsField = pkg.exports;
    const normalizedExports: Record<string, string> = {};
    if (typeof exportsField === 'object' && exportsField && !Array.isArray(exportsField)) {
      for (const [key, value] of Object.entries(exportsField)) {
        if (typeof value === 'string') normalizedExports[key] = value;
      }
    }

    packageByName.set(name, {
      packageRoot: normalizePath(path.dirname(packageFile)),
      name,
      exports: normalizedExports,
    });
  }

  const dependencyAliasToPackageName = new Map<string, string>();
  for (const sectionName of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const section = appPackage[sectionName];
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue;

    for (const [name, version] of Object.entries(section)) {
      if (typeof version !== 'string') continue;
      const aliasMatch = version.match(/workspace:(@[^@]+\/[^@]+)@/);
      dependencyAliasToPackageName.set(name, aliasMatch ? aliasMatch[1] : name);
    }
  }

  return {
    appRoot,
    workspaceRoot,
    targetPackageRoot,
    pathAliases: Object.entries(tsconfig.compilerOptions?.paths ?? {}).map(([pattern, targets]) => ({
      pattern,
      targets: Array.isArray(targets) ? targets.map(String) : [],
    })),
    packageByName,
    dependencyAliasToPackageName,
  };
}

function readTsConfig(appRoot: string): { compilerOptions?: { paths?: Record<string, string[]> } } {
  const tsconfigPath = path.join(appRoot, 'tsconfig.json');
  const parsed = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (parsed.error || !parsed.config) return {};
  return parsed.config as { compilerOptions?: { paths?: Record<string, string[]> } };
}

async function collectAnalysisFiles(
  appRoot: string,
  targetPackageRoot: string,
  componentPath: string,
): Promise<string[]> {
  const entries = await fg(
    [
      `${normalizeGlob(appRoot)}/**/*.{ts,tsx,js,jsx,mjs,cjs}`,
      `${normalizeGlob(targetPackageRoot)}/**/*.{ts,tsx,js,jsx,mjs,cjs}`,
    ],
    {
      absolute: true,
      onlyFiles: true,
      unique: true,
      ignore: [
        '**/node_modules/**',
        '**/.next/**',
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
        '**/.turbo/**',
        '**/out/**',
        '**/playwright/**',
        '**/scripts/**',
        '**/__tests__/**',
        '**/__mocks__/**',
        '**/*.test.*',
        '**/*.spec.*',
        '**/*.stories.*',
      ],
    },
  );

  const normalized = entries.map(normalizePath);
  if (!normalized.includes(componentPath)) normalized.push(componentPath);
  return normalized;
}

interface ParseOptions {
  followDynamicImports: boolean;
}

async function parseFiles(
  filePaths: string[],
  context: AppContext,
  parseOpts: ParseOptions,
): Promise<Map<string, FileSummary>> {
  const summaries = new Map<string, FileSummary>();

  for (const filePath of filePaths) {
    const text = await readFile(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFromPath(filePath),
    );
    summaries.set(filePath, parseSourceFile(sourceFile, context, parseOpts));
  }

  return summaries;
}

function parseSourceFile(sourceFile: ts.SourceFile, context: AppContext, parseOpts: ParseOptions): FileSummary {
  const filePath = normalizePath(sourceFile.fileName);
  const imports = new Map<string, ImportBinding>();
  const localSymbols = new Map<string, LocalSymbol>();
  const exportDefs: ExportDef[] = [];

  const rememberSymbol = (name: string, partial: Partial<LocalSymbol>): void => {
    const existing = localSymbols.get(name);
    if (existing) {
      existing.exported = existing.exported || Boolean(partial.exported);
      existing.isComponent = existing.isComponent || Boolean(partial.isComponent);
      if (partial.refs) existing.refs.push(...partial.refs);
      return;
    }

    localSymbols.set(name, {
      name,
      exported: Boolean(partial.exported),
      isComponent: Boolean(partial.isComponent),
      refs: partial.refs ?? [],
    });
  };

  const visitStatement = (statement: ts.Statement): void => {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const resolved = resolveImportSpecifier(statement.moduleSpecifier.text, filePath, context);
      const bindings = statement.importClause;
      if (!bindings || !resolved) return;

      if (bindings.name) {
        imports.set(bindings.name.text, {
          kind: 'symbol',
          sourceFile: resolved,
          symbolName: 'default',
        });
      }

      const namedBindings = bindings.namedBindings;
      if (!namedBindings) return;

      if (ts.isNamespaceImport(namedBindings)) {
        imports.set(namedBindings.name.text, {
          kind: 'namespace',
          sourceFile: resolved,
        });
        return;
      }

      for (const element of namedBindings.elements) {
        const localName = element.name.text;
        const importedName = element.propertyName?.text ?? element.name.text;
        imports.set(localName, {
          kind: 'symbol',
          sourceFile: resolved,
          symbolName: importedName,
        });
      }
      return;
    }

    if (ts.isExportDeclaration(statement)) {
      const resolved =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? resolveImportSpecifier(statement.moduleSpecifier.text, filePath, context)
          : null;

      if (!statement.exportClause) {
        if (resolved) {
          exportDefs.push({
            kind: 'star-from',
            sourceFile: resolved,
          });
        }
        return;
      }

      if (ts.isNamedExports(statement.exportClause)) {
        for (const specifier of statement.exportClause.elements) {
          const exportedName = specifier.name.text;
          const sourceSymbol = specifier.propertyName?.text ?? specifier.name.text;

          if (resolved) {
            exportDefs.push({
              kind: exportedName === 'default' ? 'default-from' : 'named-from',
              exportedName,
              sourceFile: resolved,
              sourceSymbol,
            });
          } else {
            exportDefs.push({
              kind: exportedName === 'default' ? 'default-local' : 'named-local',
              exportedName,
              localName: sourceSymbol,
            });
            rememberSymbol(sourceSymbol, { exported: true });
          }
        }
      }
      return;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      rememberSymbol(name, {
        isComponent: isComponentName(name),
        refs: extractRefsFromBody(statement.body, imports),
      });
      if (hasExportModifier(statement.modifiers)) {
        rememberSymbol(name, { exported: true });
        exportDefs.push({ kind: 'named-local', exportedName: name, localName: name });
      }
      if (hasDefaultModifier(statement.modifiers)) {
        exportDefs.push({ kind: 'default-local', localName: name });
      }
      return;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      rememberSymbol(name, { isComponent: isComponentName(name), refs: [] });
      if (hasExportModifier(statement.modifiers)) {
        rememberSymbol(name, { exported: true });
        exportDefs.push({ kind: 'named-local', exportedName: name, localName: name });
      }
      if (hasDefaultModifier(statement.modifiers)) {
        exportDefs.push({ kind: 'default-local', localName: name });
      }
      return;
    }

    if (ts.isVariableStatement(statement)) {
      const exported = hasExportModifier(statement.modifiers);
      const defaultExported = hasDefaultModifier(statement.modifiers);

      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        const symbol = parseVariableSymbol(name, declaration.initializer, imports);
        if (symbol) {
          rememberSymbol(name, symbol);
        }

        if (parseOpts.followDynamicImports && declaration.initializer && isComponentName(name)) {
          const dynRefs = extractDynamicImportRefs(declaration.initializer, filePath, context);
          if (dynRefs.length > 0) {
            rememberSymbol(name, { isComponent: true, refs: dynRefs });
          }
        }

        if (exported) {
          rememberSymbol(name, { exported: true });
          exportDefs.push({ kind: 'named-local', exportedName: name, localName: name });
        }

        if (defaultExported) {
          exportDefs.push({ kind: 'default-local', localName: name });
        }
      }
      return;
    }

    if (ts.isExportAssignment(statement)) {
      const ref = resolveExpressionRef(statement.expression, imports);
      if (ref?.kind === 'local') {
        exportDefs.push({
          kind: 'default-local',
          localName: ref.symbolName,
        });
      } else if (ref?.kind === 'external' && ref.filePath) {
        exportDefs.push({
          kind: 'default-from',
          sourceFile: ref.filePath,
          sourceSymbol: ref.symbolName,
        });
      }
    }
  };

  for (const statement of sourceFile.statements) {
    visitStatement(statement);
  }

  return {
    filePath,
    localSymbols,
    exportDefs,
  };
}

function parseVariableSymbol(
  name: string,
  initializer: ts.Expression | undefined,
  imports: Map<string, ImportBinding>,
): Partial<LocalSymbol> | null {
  if (!initializer) return null;

  let unwrapped = initializer;
  while (
    ts.isParenthesizedExpression(unwrapped) ||
    ts.isAsExpression(unwrapped) ||
    ts.isSatisfiesExpression(unwrapped) ||
    ts.isTypeAssertionExpression(unwrapped)
  ) {
    unwrapped = unwrapped.expression;
  }

  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
    return {
      isComponent: isComponentName(name),
      refs: extractRefsFromBody(unwrapped.body, imports),
    };
  }

  if (ts.isCallExpression(unwrapped)) {
    if (isObjectAssignCall(unwrapped) && unwrapped.arguments.length > 0) {
      const baseRef = resolveExpressionRef(unwrapped.arguments[0], imports);
      if (baseRef) {
        return {
          isComponent: isComponentName(name),
          refs: [baseRef],
        };
      }
    }

    const callback = unwrapped.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
    if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
      return {
        isComponent: isComponentName(name),
        refs: extractRefsFromBody(callback.body, imports),
      };
    }

    const ref = resolveExpressionRef(unwrapped.expression, imports);
    if (ref) {
      return {
        isComponent: isComponentName(name),
        refs: [ref],
      };
    }
  }

  if (ts.isObjectLiteralExpression(unwrapped) && isComponentName(name)) {
    const refs: LocalRef[] = [];
    for (const prop of unwrapped.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        refs.push(resolveIdentifierRef(prop.name.text, imports));
      } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)) {
        refs.push(resolveIdentifierRef(prop.initializer.text, imports));
      }
    }
    return { isComponent: true, refs };
  }

  const directRef = resolveExpressionRef(unwrapped, imports);
  if (directRef) {
    return {
      isComponent: isComponentName(name),
      refs: [directRef],
    };
  }

  return null;
}

function extractDynamicImportRefs(
  node: ts.Node,
  importerFile: string,
  context: AppContext,
): LocalRef[] {
  const refs: LocalRef[] = [];

  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments.length > 0 &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      const specifier = n.arguments[0].text;
      const resolved = resolveImportSpecifier(specifier, importerFile, context);
      if (resolved) {
        let symbolName = 'default';
        const parent = n.parent;
        if (
          parent &&
          ts.isPropertyAccessExpression(parent) &&
          parent.name.text === 'then'
        ) {
          const thenCall = parent.parent;
          if (thenCall && ts.isCallExpression(thenCall) && thenCall.arguments.length > 0) {
            const cb = thenCall.arguments[0];
            if ((ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && ts.isPropertyAccessExpression(cb.body)) {
              symbolName = cb.body.name.text;
            }
          }
        }
        refs.push({ kind: 'external', filePath: resolved, symbolName });
      }
    }

    ts.forEachChild(n, visit);
  };

  visit(node);
  return refs;
}

function extractRefsFromBody(
  body: ts.ConciseBody | undefined,
  imports: Map<string, ImportBinding>,
): LocalRef[] {
  if (!body) return [];

  const refs: LocalRef[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const ref = jsxTagToRef(node.tagName, imports);
      if (ref) refs.push(ref);
    }

    if (ts.isCallExpression(node) && isCreateElementCall(node)) {
      const [firstArg] = node.arguments;
      const ref = firstArg ? resolveExpressionRef(firstArg, imports) : null;
      if (ref) refs.push(ref);
    }

    ts.forEachChild(node, visit);
  };

  visit(body);
  return refs;
}

function jsxTagToRef(
  tagName: ts.JsxTagNameExpression,
  imports: Map<string, ImportBinding>,
): LocalRef | null {
  if (ts.isIdentifier(tagName)) {
    if (!isComponentName(tagName.text)) return null;
    return resolveIdentifierRef(tagName.text, imports);
  }

  if (ts.isPropertyAccessExpression(tagName)) {
    if (!ts.isIdentifier(tagName.expression)) return null;
    const binding = imports.get(tagName.expression.text);
    if (!binding) return null;

    if (binding.kind === 'namespace') {
      if (!isComponentName(tagName.name.text)) return null;
      return {
        kind: 'external',
        filePath: binding.sourceFile,
        symbolName: tagName.name.text,
      };
    }

    if (binding.kind === 'symbol' && binding.symbolName) {
      return {
        kind: 'external',
        filePath: binding.sourceFile,
        symbolName: binding.symbolName,
      };
    }
  }

  return null;
}

function resolveExpressionRef(
  expression: ts.Expression,
  imports: Map<string, ImportBinding>,
): LocalRef | null {
  if (ts.isIdentifier(expression)) {
    return resolveIdentifierRef(expression.text, imports);
  }

  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const namespaceBinding = imports.get(expression.expression.text);
    if (namespaceBinding?.kind === 'namespace') {
      return {
        kind: 'external',
        filePath: namespaceBinding.sourceFile,
        symbolName: expression.name.text,
      };
    }
  }

  return null;
}

function resolveIdentifierRef(
  name: string,
  imports: Map<string, ImportBinding>,
): LocalRef {
  const imported = imports.get(name);
  if (imported?.kind === 'symbol' && imported.symbolName) {
    return {
      kind: 'external',
      filePath: imported.sourceFile,
      symbolName: imported.symbolName,
    };
  }

  return {
    kind: 'local',
    symbolName: name,
  };
}

function buildGraph(summaries: Map<string, FileSummary>): Map<string, GraphNode> {
  const graph = new Map<string, GraphNode>();

  const ensureNode = (filePath: string, name: string, kind: 'component' | 'alias'): GraphNode => {
    const key = makeKey(filePath, name);
    const existing = graph.get(key);
    if (existing) {
      if (kind === 'component') existing.kind = 'component';
      return existing;
    }

    const node: GraphNode = {
      key,
      name,
      filePath,
      kind,
      edges: new Set<string>(),
    };
    graph.set(key, node);
    return node;
  };

  for (const summary of summaries.values()) {
    for (const symbol of summary.localSymbols.values()) {
      const node = ensureNode(
        summary.filePath,
        symbol.name,
        symbol.isComponent ? 'component' : 'alias',
      );

      for (const ref of symbol.refs) {
        if (ref.kind === 'local') {
          node.edges.add(makeKey(summary.filePath, ref.symbolName));
        } else if (ref.filePath) {
          node.edges.add(makeKey(ref.filePath, ref.symbolName));
        }
      }
    }
  }

  const exportNameCache = new Map<string, Set<string>>();
  for (const summary of summaries.values()) {
    const exportedNames = getExportedNames(summary.filePath, summaries, exportNameCache, new Set());
    for (const exportName of exportedNames) {
      ensureNode(summary.filePath, exportName, 'alias');
    }
  }

  for (const summary of summaries.values()) {
    for (const exportDef of summary.exportDefs) {
      if (exportDef.kind === 'named-local' && exportDef.exportedName && exportDef.localName) {
        if (exportDef.exportedName !== exportDef.localName) {
          ensureNode(summary.filePath, exportDef.exportedName, 'alias').edges.add(
            makeKey(summary.filePath, exportDef.localName),
          );
        }
        continue;
      }

      if (exportDef.kind === 'default-local' && exportDef.localName) {
        ensureNode(summary.filePath, 'default', 'alias').edges.add(
          makeKey(summary.filePath, exportDef.localName),
        );
        continue;
      }

      if (
        (exportDef.kind === 'named-from' || exportDef.kind === 'default-from') &&
        exportDef.sourceFile &&
        exportDef.sourceSymbol
      ) {
        const targetName = exportDef.kind === 'default-from' ? 'default' : exportDef.exportedName!;
        ensureNode(summary.filePath, targetName, 'alias').edges.add(
          makeKey(exportDef.sourceFile, exportDef.sourceSymbol),
        );
        continue;
      }

      if (exportDef.kind === 'star-from' && exportDef.sourceFile) {
        const sourceExportNames = getExportedNames(
          exportDef.sourceFile,
          summaries,
          exportNameCache,
          new Set(),
        );
        for (const name of sourceExportNames) {
          if (name === 'default') continue;
          ensureNode(summary.filePath, name, 'alias').edges.add(
            makeKey(exportDef.sourceFile, name),
          );
        }
      }
    }
  }

  return graph;
}

function getExportedNames(
  filePath: string,
  summaries: Map<string, FileSummary>,
  cache: Map<string, Set<string>>,
  visiting: Set<string>,
): Set<string> {
  const cached = cache.get(filePath);
  if (cached) return cached;
  if (visiting.has(filePath)) return new Set();

  visiting.add(filePath);
  const summary = summaries.get(filePath);
  const names = new Set<string>();

  if (summary) {
    for (const exportDef of summary.exportDefs) {
      if (exportDef.kind === 'named-local' && exportDef.exportedName) names.add(exportDef.exportedName);
      if (exportDef.kind === 'default-local') names.add('default');
      if (exportDef.kind === 'named-from' && exportDef.exportedName) names.add(exportDef.exportedName);
      if (exportDef.kind === 'default-from') names.add('default');

      if (exportDef.kind === 'star-from' && exportDef.sourceFile) {
        const sourceNames = getExportedNames(exportDef.sourceFile, summaries, cache, visiting);
        for (const name of sourceNames) {
          if (name !== 'default') names.add(name);
        }
      }
    }
  }

  visiting.delete(filePath);
  cache.set(filePath, names);
  return names;
}

async function buildRouteInventory(appRoot: string): Promise<{
  pages: RouteFile[];
  layouts: RouteFile[];
  templates: RouteFile[];
  pagesApp: RouteFile[];
  all: RouteFile[];
}> {
  const appDir = ts.sys.directoryExists(path.join(appRoot, 'src', 'app'))
    ? path.join(appRoot, 'src', 'app')
    : path.join(appRoot, 'app');
  const pagesDir = ts.sys.directoryExists(path.join(appRoot, 'src', 'pages'))
    ? path.join(appRoot, 'src', 'pages')
    : path.join(appRoot, 'pages');

  const appEntries = await fg(`${normalizeGlob(appDir)}/**/*.{ts,tsx,js,jsx}`, {
    absolute: true,
    onlyFiles: true,
    ignore: ['**/node_modules/**', '**/.next/**'],
  });
  const pagesEntries = await fg(`${normalizeGlob(pagesDir)}/**/*.{ts,tsx,js,jsx}`, {
    absolute: true,
    onlyFiles: true,
    ignore: ['**/node_modules/**', '**/.next/**', '**/api/**'],
  });

  const pages: RouteFile[] = [];
  const layouts: RouteFile[] = [];
  const templates: RouteFile[] = [];
  const pagesApp: RouteFile[] = [];

  for (const rawFilePath of appEntries) {
    const filePath = normalizePath(rawFilePath);
    const baseName = path.basename(filePath, path.extname(filePath));
    if (!['page', 'layout', 'template'].includes(baseName)) continue;

    const relativeDir = normalizePath(path.dirname(path.relative(appDir, filePath)));
    const route = normalizeAppRoute(relativeDir);
    const routeGroupPath = relativeDir === '.' ? '' : relativeDir;
    const routeFile: RouteFile = {
      filePath,
      route,
      kind:
        baseName === 'page'
          ? 'app-page'
          : baseName === 'layout'
            ? 'app-layout'
            : 'app-template',
      routeGroupPath,
    };

    if (routeFile.kind === 'app-page') pages.push(routeFile);
    if (routeFile.kind === 'app-layout') layouts.push(routeFile);
    if (routeFile.kind === 'app-template') templates.push(routeFile);
  }

  for (const rawFilePath of pagesEntries) {
    const filePath = normalizePath(rawFilePath);
    const relativeFile = normalizePath(path.relative(pagesDir, filePath));
    const noExt = relativeFile.slice(0, -path.extname(relativeFile).length);
    const route = normalizePagesRoute(noExt);
    const baseName = path.basename(noExt);

    if (baseName === '_app') {
      pagesApp.push({
        filePath,
        route,
        kind: 'pages-app',
        routeGroupPath: '',
      });
      continue;
    }

    if (baseName === '_document' || baseName === '_error') continue;
    pages.push({
      filePath,
      route,
      kind: 'pages-page',
      routeGroupPath: normalizePath(path.dirname(noExt)),
    });
  }

  return {
    pages,
    layouts,
    templates,
    pagesApp,
    all: [...pages, ...layouts, ...templates, ...pagesApp],
  };
}

function collectRouteEntries(
  routeFiles: RouteFile[],
  summaries: Map<string, FileSummary>,
  graph: Map<string, GraphNode>,
): RouteEntry[] {
  const entries: RouteEntry[] = [];

  for (const routeFile of routeFiles) {
    const summary = summaries.get(routeFile.filePath);
    if (!summary) continue;

    const preferred = [makeKey(routeFile.filePath, 'default')];
    const exportedNames = [...getSimpleExportNames(summary)];
    for (const name of exportedNames) {
      preferred.push(makeKey(routeFile.filePath, name));
    }

    for (const key of preferred) {
      if (!graph.has(key)) continue;
      entries.push({ routeFile, startKey: key });
    }
  }

  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.routeFile.filePath}:${entry.startKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveRoutes(
  routeInventory: {
    pages: RouteFile[];
    layouts: RouteFile[];
    templates: RouteFile[];
    pagesApp: RouteFile[];
    all: RouteFile[];
  },
  routeEntries: RouteEntry[],
  targetKeys: string[],
  graph: Map<string, GraphNode>,
  buildArtifacts: BuildArtifactsInfo | null,
): RouteMatch[] {
  const results = new Map<string, RouteMatch>();
  const targetSet = new Set(targetKeys);

  for (const routeEntry of routeEntries) {
    const pathKeys = shortestPath(routeEntry.startKey, targetSet, graph);
    if (!pathKeys) continue;

    const stack = stackFromPath(pathKeys, graph, targetSet);
    const expansions = expandRouteEntry(routeEntry.routeFile, routeInventory);

    for (const expanded of expansions) {
      const match = buildRouteMatch(
        expanded.route,
        expanded.entryFile,
        stack,
        expanded.reason,
        expanded.notes,
        buildArtifacts,
      );

      const existing = results.get(match.route);
      if (!existing || match.confidenceScore > existing.confidenceScore) {
        results.set(match.route, match);
      }
    }
  }

  return [...results.values()].sort((a, b) => {
    if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;
    return a.route.localeCompare(b.route);
  });
}

function expandRouteEntry(
  routeFile: RouteFile,
  routeInventory: {
    pages: RouteFile[];
    layouts: RouteFile[];
    templates: RouteFile[];
    pagesApp: RouteFile[];
  },
): Array<{ route: string; entryFile: string; reason: RouteReason; notes: string[] }> {
  switch (routeFile.kind) {
    case 'app-page':
    case 'pages-page':
      return [
        {
          route: routeFile.route,
          entryFile: routeFile.filePath,
          reason: 'direct-page-usage',
          notes: [],
        },
      ];
    case 'app-layout':
      return routeInventory.pages
        .filter((page) => page.kind === 'app-page')
        .filter((page) => isRouteWithinScope(page, routeFile))
        .map((page) => ({
          route: page.route,
          entryFile: page.filePath,
          reason: 'shared-layout' as const,
          notes: [`via layout ${routeFile.filePath}`],
        }));
    case 'app-template':
      return routeInventory.pages
        .filter((page) => page.kind === 'app-page')
        .filter((page) => isRouteWithinScope(page, routeFile))
        .map((page) => ({
          route: page.route,
          entryFile: page.filePath,
          reason: 'shared-template' as const,
          notes: [`via template ${routeFile.filePath}`],
        }));
    case 'pages-app':
      return routeInventory.pages
        .filter((page) => page.kind === 'pages-page')
        .map((page) => ({
          route: page.route,
          entryFile: page.filePath,
          reason: 'global-wrapper' as const,
          notes: [`via pages/_app ${routeFile.filePath}`],
        }));
    default:
      return [];
  }
}

function shortestPath(
  startKey: string,
  targetKeys: Set<string>,
  graph: Map<string, GraphNode>,
): string[] | null {
  const queue: Array<{ key: string; path: string[] }> = [{ key: startKey, path: [startKey] }];
  const seen = new Set<string>([startKey]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (targetKeys.has(current.key)) return current.path;

    const node = graph.get(current.key);
    if (!node) continue;

    for (const edge of node.edges) {
      if (seen.has(edge)) continue;
      seen.add(edge);
      queue.push({
        key: edge,
        path: [...current.path, edge],
      });
    }
  }

  return null;
}

function stackFromPath(
  pathKeys: string[],
  graph: Map<string, GraphNode>,
  targetKeys: Set<string>,
): StackFrame[] {
  const frames: StackFrame[] = [];

  for (const key of pathKeys) {
    const node = graph.get(key);
    if (!node) continue;
    const isTarget = targetKeys.has(key);
    if (node.kind !== 'component' && !isTarget) continue;

    const last = frames[frames.length - 1];
    if (last && last.filePath === node.filePath && last.symbolName === node.name) {
      continue;
    }

    frames.push({
      filePath: node.filePath,
      symbolName: node.name,
    });
  }

  return frames;
}

function buildRouteMatch(
  route: string,
  entryFile: string,
  stack: StackFrame[],
  reason: RouteReason,
  notes: string[],
  buildArtifacts: BuildArtifactsInfo | null,
): RouteMatch {
  let confidenceScore =
    reason === 'direct-page-usage'
      ? 0.95
      : reason === 'shared-layout'
        ? 0.88
        : reason === 'shared-template'
          ? 0.86
          : 0.84;

  if (stack.length > 4) confidenceScore -= 0.03;
  const finalNotes = [...notes];

  if (buildArtifacts) {
    if (buildArtifacts.builtRoutes.has(route)) {
      confidenceScore = Math.min(0.99, confidenceScore + 0.03);
      finalNotes.push('confirmed in .next manifests');
    } else if (buildArtifacts.manifests.length > 0) {
      confidenceScore = Math.max(0.4, confidenceScore - 0.08);
      finalNotes.push('not present in discovered .next manifests');
    }
  }

  return {
    route,
    entryFile,
    stack,
    symbols: stack.map((frame) => frame.symbolName),
    confidence: confidenceScore >= 0.9 ? 'high' : confidenceScore >= 0.75 ? 'medium' : 'low',
    confidenceScore,
    notes: finalNotes,
    qaReason: reason,
  };
}

async function readBuildArtifacts(appRoot: string): Promise<BuildArtifactsInfo | null> {
  const nextDir = path.join(appRoot, '.next');
  const candidates = [
    path.join(nextDir, 'app-path-routes-manifest.json'),
    path.join(nextDir, 'server', 'app-path-routes-manifest.json'),
    path.join(nextDir, 'routes-manifest.json'),
  ];

  const builtRoutes = new Set<string>();
  const manifests: string[] = [];

  for (const manifestPath of candidates) {
    try {
      const raw = await readFile(manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      manifests.push(manifestPath);

      if (Array.isArray(parsed.staticRoutes)) {
        for (const route of parsed.staticRoutes) {
          if (route && typeof route === 'object' && 'page' in route && typeof route.page === 'string') {
            builtRoutes.add(route.page);
          }
        }
      }

      if (Array.isArray(parsed.dynamicRoutes)) {
        for (const route of parsed.dynamicRoutes) {
          if (route && typeof route === 'object' && 'page' in route && typeof route.page === 'string') {
            builtRoutes.add(route.page);
          }
        }
      }

      for (const value of Object.values(parsed)) {
        if (typeof value === 'string' && value.startsWith('/')) {
          builtRoutes.add(value);
        }
      }
    } catch {
      // Ignore missing manifests.
    }
  }

  if (manifests.length === 0) return null;
  return { builtRoutes, manifests };
}

function resolveImportSpecifier(
  specifier: string,
  importerFile: string,
  context: AppContext,
): string | null {
  if (specifier.startsWith('.')) {
    return resolveFilePath(path.resolve(path.dirname(importerFile), specifier));
  }

  for (const alias of context.pathAliases) {
    const matched = matchAlias(specifier, alias.pattern);
    if (!matched) continue;

    for (const target of alias.targets) {
      const substituted = applyAliasTarget(target, matched);
      const resolved = resolveFilePath(path.resolve(context.appRoot, substituted));
      if (resolved) return resolved;
    }
  }

  const packageResolution = resolveWorkspacePackageImport(specifier, context);
  if (packageResolution) return packageResolution;

  return null;
}

function resolveWorkspacePackageImport(specifier: string, context: AppContext): string | null {
  const { packageBase, subpath } = splitPackageSpecifier(specifier);
  const actualPackageName =
    context.dependencyAliasToPackageName.get(packageBase) ??
    context.dependencyAliasToPackageName.get(specifier) ??
    packageBase;

  const pkg = context.packageByName.get(actualPackageName);
  if (!pkg) return null;

  const exportKey = subpath ? `./${subpath}` : '.';
  const direct = pkg.exports[exportKey];
  if (direct) {
    return resolveFilePath(path.join(pkg.packageRoot, direct));
  }

  for (const [key, value] of Object.entries(pkg.exports)) {
    if (!key.includes('*')) continue;
    const matched = matchAlias(exportKey, key);
    if (!matched) continue;
    return resolveFilePath(path.join(pkg.packageRoot, value.replace('*', matched)));
  }

  if (subpath) {
    return resolveFilePath(path.join(pkg.packageRoot, subpath));
  }

  return resolveFilePath(path.join(pkg.packageRoot, 'index'));
}

function splitPackageSpecifier(specifier: string): { packageBase: string; subpath: string } {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return {
      packageBase: `${parts[0]}/${parts[1]}`,
      subpath: parts.slice(2).join('/'),
    };
  }

  const parts = specifier.split('/');
  return {
    packageBase: parts[0],
    subpath: parts.slice(1).join('/'),
  };
}

function resolveFilePath(basePath: string): string | null {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.tsx'),
    path.join(basePath, 'index.js'),
    path.join(basePath, 'index.jsx'),
  ];

  for (const candidate of candidates) {
    try {
      if (ts.sys.fileExists(candidate)) {
        return normalizePath(candidate);
      }
    } catch {
      // Ignore.
    }
  }

  return null;
}

function matchAlias(value: string, pattern: string): string | null {
  if (!pattern.includes('*')) {
    return value === pattern ? '' : null;
  }

  const [before, after] = pattern.split('*');
  if (!value.startsWith(before) || !value.endsWith(after)) return null;
  return value.slice(before.length, value.length - after.length);
}

function applyAliasTarget(target: string, wildcard: string): string {
  return target.replace('*', wildcard);
}

function getSimpleExportNames(summary: FileSummary): Set<string> {
  const names = new Set<string>();
  for (const exportDef of summary.exportDefs) {
    if (exportDef.kind === 'named-local' && exportDef.exportedName) names.add(exportDef.exportedName);
    if (exportDef.kind === 'named-from' && exportDef.exportedName) names.add(exportDef.exportedName);
    if (exportDef.kind === 'default-local' || exportDef.kind === 'default-from') names.add('default');
  }
  return names;
}

function resolveTargetKeys(summary: FileSummary, exportName?: string): string[] {
  const allComponentKeys = [...summary.localSymbols.values()]
    .filter((symbol) => symbol.exported && symbol.isComponent)
    .map((symbol) => makeKey(summary.filePath, symbol.name));

  if (!exportName) {
    return allComponentKeys;
  }

  const keys = new Set<string>();
  for (const exportDef of summary.exportDefs) {
    if (
      exportDef.kind === 'named-local' &&
      exportDef.exportedName === exportName &&
      exportDef.localName
    ) {
      const symbol = summary.localSymbols.get(exportDef.localName);
      if (symbol?.isComponent) keys.add(makeKey(summary.filePath, symbol.name));
    }

    if (
      exportName === 'default' &&
      exportDef.kind === 'default-local' &&
      exportDef.localName
    ) {
      const symbol = summary.localSymbols.get(exportDef.localName);
      if (symbol?.isComponent) keys.add(makeKey(summary.filePath, symbol.name));
    }
  }

  return [...keys];
}

function hasExportModifier(modifiers: readonly ts.ModifierLike[] | undefined): boolean {
  return Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function hasDefaultModifier(modifiers: readonly ts.ModifierLike[] | undefined): boolean {
  return Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
}

function isObjectAssignCall(node: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Object' &&
    node.expression.name.text === 'assign'
  );
}

function isCreateElementCall(node: ts.CallExpression): boolean {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text === 'createElement';
  }
  return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'createElement';
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function scriptKindFromPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function makeKey(filePath: string, symbolName: string): string {
  return `${normalizePath(filePath)}::${symbolName}`;
}

function normalizeAppRoute(relativeDir: string): string {
  if (relativeDir === '.' || relativeDir === '') return '/';
  const parts = normalizePath(relativeDir)
    .split('/')
    .filter(Boolean)
    .filter((part) => !isRouteGroup(part))
    .filter((part) => !part.startsWith('@'))
    .filter((part) => !isPrivateSegment(part));

  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

function normalizePagesRoute(noExtRelativeFile: string): string {
  const parts = normalizePath(noExtRelativeFile)
    .split('/')
    .filter(Boolean)
    .filter((part) => !isPrivateSegment(part));

  if (parts.length === 0) return '/';
  if (parts[parts.length - 1] === 'index') parts.pop();
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

function isRouteGroup(segment: string): boolean {
  return /^\(.*\)$/.test(segment);
}

function isPrivateSegment(segment: string): boolean {
  return segment.startsWith('_') && !segment.startsWith('__');
}

function isRouteWithinScope(page: RouteFile, owner: RouteFile): boolean {
  if (!owner.routeGroupPath) return true;
  const ownerScope = `${owner.routeGroupPath}/`;
  return page.routeGroupPath === owner.routeGroupPath || page.routeGroupPath.startsWith(ownerScope);
}

async function buildFingerprint(
  appRoot: string,
  workspaceRoot: string,
  componentPath: string,
  exportName?: string,
): Promise<string> {
  const files = [
    path.join(appRoot, 'package.json'),
    path.join(appRoot, 'tsconfig.json'),
    path.join(workspaceRoot, 'package.json'),
    componentPath,
  ];

  const parts: string[] = [];
  for (const filePath of files) {
    try {
      const fileStat = await stat(filePath);
      parts.push(`${normalizePath(filePath)}:${fileStat.size}:${fileStat.mtimeMs}`);
    } catch {
      parts.push(`${normalizePath(filePath)}:missing`);
    }
  }

  parts.push(`export:${exportName ?? ''}`);
  return stableHash(parts.join('|'));
}


async function findPackageRoot(startFile: string): Promise<string> {
  let current = path.dirname(startFile);

  while (true) {
    const packageJson = path.join(current, 'package.json');
    try {
      await stat(packageJson);
      return normalizePath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Could not find package root above ${startFile}`);
      }
      current = parent;
    }
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function normalizePath(value: string): string {
  return value.split(path.sep).join('/');
}

function normalizeGlob(value: string): string {
  return normalizePath(value).replace(/\\/g, '/');
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
