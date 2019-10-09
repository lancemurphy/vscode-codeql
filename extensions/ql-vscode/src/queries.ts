import * as cp from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as tmp from 'tmp';
import * as vscode from 'vscode';
import * as Sarif from 'sarif';
import { ProgressLocation, window as Window, workspace } from 'vscode';
import * as cli from './cli';
import { QLConfiguration } from './config';
import { DatabaseItem } from './databases';
import * as helpers from './helpers';
import { DatabaseInfo } from './interface-types';
import { logger, Logger } from './logging';
import * as messages from './messages';
import * as qsClient from './queryserver-client';

/**
 * queries.ts
 * -------------
 *
 * Compiling and running QL queries.
 */

// XXX: Tmp directory should be configuarble.
export const tmpDir = tmp.dirSync({ prefix: 'queries_', keep: false, unsafeCleanup: true });
const upgradesTmpDir = tmp.dirSync({ dir: tmpDir.name, prefix: 'upgrades_', keep: false, unsafeCleanup: true });
export const tmpDirDisposal = {
  dispose: () => {
    upgradesTmpDir.removeCallback();
    tmpDir.removeCallback();
  }
};

let queryCounter = 0;

/**
 * A collection of evaluation-time information about a query,
 * including the query itself, and where we have decided to put
 * temporary files associated with it, such as the compiled query
 * output and results.
 */
class QueryInfo {
  metadata?: cli.QueryMetadata;
  program: messages.QlProgram;
  quickEvalPosition?: messages.Position;
  compiledQueryPath: string;
  resultsPath: string;
  interpretedResultsPath: string;
  dbItem: DatabaseItem;
  dataset: vscode.Uri; // guarantee the existence of a well-defined dataset dir at this point

  constructor(program: messages.QlProgram, dbItem: DatabaseItem, quickEvalPosition?: messages.Position, metadata?: cli.QueryMetadata) {
    this.metadata = metadata;
    this.program = program;
    this.quickEvalPosition = quickEvalPosition;
    this.compiledQueryPath = path.join(tmpDir.name, `compiledQuery${queryCounter}.qlo`);
    this.resultsPath = path.join(tmpDir.name, `results${queryCounter}.bqrs`);
    this.interpretedResultsPath = path.join(tmpDir.name, `interpretedResults${queryCounter}.sarif`);
    if (dbItem.contents === undefined) {
      throw new Error('Can\'t run query on invalid database.');
    }
    this.dataset = dbItem.contents.datasetUri;
    this.dbItem = dbItem;
    queryCounter++;
  }

  async run(
    qs: qsClient.QueryServerClient,
  ): Promise<messages.EvaluationResult> {
    let result: messages.EvaluationResult | null = null;

    const callbackId = qs.registerCallback(res => { result = res });

    const queryToRun: messages.QueryToRun = {
      resultsPath: this.resultsPath,
      qlo: vscode.Uri.file(this.compiledQueryPath).toString(),
      allowUnknownTemplates: true,
      id: callbackId,
      timeoutSecs: qs.config.timeoutSecs,
    }
    const dataset: messages.Dataset = {
      dbDir: this.dataset.fsPath,
      workingSet: 'default'
    }
    const params: messages.EvaluateQueriesParams = {
      db: dataset,
      evaluateId: callbackId,
      queries: [queryToRun],
      stopOnError: false,
      useSequenceHint: false
    }
    try {
      await withProgress({
        location: ProgressLocation.Notification,
        title: "Running Query",
        cancellable: false,
      }, (progress, token) => {
        return qs.sendRequest(messages.runQueries, params, token, progress)
      });
    } finally {
      qs.unRegisterCallback(callbackId);
    }
    return result || { evaluationTime: 0, message: "No result from server", queryId: -1, runId: callbackId, resultType: messages.QueryResultType.OTHER_ERROR };
  }

  async compileAndRun(
    qs: qsClient.QueryServerClient,
  ): Promise<messages.EvaluationResult> {
    let compiled: messages.CheckQueryResult;
    try {
      const params: messages.CompileQueryParams = {
        compilationOptions: {
          computeNoLocationUrls: true,
          failOnWarnings: false,
          fastCompilation: false,
          includeDilInQlo: true,
          localChecking: false,
          noComputeGetUrl: false,
          noComputeToString: false,
        },
        extraOptions: {
          timeoutSecs: qs.config.timeoutSecs
        },
        queryToCheck: this.program,
        resultPath: this.compiledQueryPath,
        target: !!this.quickEvalPosition ? { quickEval: { quickEvalPos: this.quickEvalPosition } } : { query: {} }
      };


      compiled = await withProgress({
        location: ProgressLocation.Notification,
        title: "Compiling Query",
        cancellable: false,
      }, (progress, token) => {
        return qs.sendRequest(messages.compileQuery, params, token, progress);
      });
    } finally {
      qs.logger.log(" - - - COMPILATION DONE - - - ");
    }

    const errors = (compiled.messages || []).filter(msg => msg.severity == 0);
    if (errors.length == 0) {
      return await this.run(qs);
    }
    else {
      // Error dialogs are limited in size and scrollability,
      // so we include a general description of the problem,
      // and direct the user to the output window for the detailed compilation messages.
      // TODO: distinguish better between user-written errors and DB scheme mismatches.
      qs.logger.log(`Failed to compile query ${this.program.queryPath} against database scheme ${this.program.dbschemePath}:`);
      for (const error of errors) {
        const message = error.message || "[no error message available]";
        qs.logger.log(`ERROR: ${message} (${error.position.fileName}:${error.position.line}:${error.position.column}:${error.position.endLine}:${error.position.endColumn})`);
      }
      helpers.showAndLogErrorMessage("Query compilation failed. Please make sure there are no errors in the query, the database is up to date, and the query and database use the same target language. For more details on the error, go to View > Output, and choose QL Query Server from the dropdown.");
      return {
        evaluationTime: 0,
        resultType: messages.QueryResultType.OTHER_ERROR,
        queryId: -1,
        runId: -1,
        message: "Query had compilation errors"
      }
    }
  }

  /**
   * Holds if this query should produce interpreted results.
   */
  hasInterpretedResults(): boolean {
    return this.dbItem.hasDbInfo();
  }

  /**
   * Interpret exit code of InterpretQueryResultsOnExportedSnapshot
   */
  interpretExitCode(logger: Logger, exitCode: number): boolean {
    switch (exitCode) {
      case 0: return true;
      case 2: // Missing kind
        logger.log("Query cannot be interpreted for SARIF export. Please add a suitable @kind property to the query metadata.");
        return false;
      case 3: // Missing id
        logger.log("Query cannot be interpreted for SARIF export. Please add a suitable @id property to the query metadata.");
        return false;
      case 4: // Invalid result patterns
        logger.log("Query cannot be interpreted for SARIF export. Please ensure the appropriate columns are selected for the given query kind.");
        return false;
      case 5: // Incompatible kind, should not occur in this case
        logger.log("Query cannot be interpreted for SARIF export due to an unexpected error.");
        return false;
      case 6: // Missing @metricType on a metric query
        logger.log("Query cannot be interpreted for SARIF export. Please add a suitable @metricType property to the query metadata.");
        return false;
      case 7: // Unsupported @kind
        logger.log("Query cannot be interpreted for SARIF export because the specified @kind value is not supported");
        return false;
    }
    logger.log("Failed to export results of query.");
    return false;
  }

  /**
   * Call shell command to interpret results, and return when it finishes.
   */
  async interpretResults(config: QLConfiguration, logger: Logger): Promise<Sarif.Log> {
    const command = config.javaCommand!;
    const args = [
      "-cp", path.resolve(config.qlDistributionPath, 'tools/odasa.jar'),
      "com.semmle.odasa.internal.InterpretQueryResultsOnExportedSnapshot",
      "--query", this.program.queryPath,
      "--results", this.resultsPath,
      "--exported-snapshot", this.dbItem.snapshotUri.fsPath,
      "--output-file", this.interpretedResultsPath,
      "--format", "sarifv2.1.0",
    ];
    logger.log(`Interpreting results via shell command ${command} ${args.join(" ")}`);
    const child = cp.spawn(command, args);
    if (!child || !child.pid) {
      throw new Error(`Spawning shell command to interpreting results failed.`);
    }
    let error = false;
    child.stdout.on('data', data => {
      logger.log(`stdout: ${data}`);
    });
    child.stderr.on('data', data => {
      // TODO: Is it actually the case that we should consider any
      // write stderr as signalling an error condition? Revisit for
      // the new CLI.
      logger.log(`stderr: ${data}`);
      error = true;
    });
    await new Promise((res, rej) => {
      child.on('close', (code) => {
        logger.log(`Child process for results interpretation exited with code ${code}`);
        if (code != 0) {
          error = error || !this.interpretExitCode(logger, code);
        }
        if (error) rej(new Error(`Error code ${code} from results interpretation.`)); else res();
      });
    });
    if (!fs.existsSync(this.interpretedResultsPath)) {
      throw new Error(`File ${this.interpretedResultsPath} not created by results interpretation.`);
    }
    return JSON.parse(await fs.readFile(this.interpretedResultsPath, 'utf8'));
  }
}

export interface EvaluationInfo {
  query: QueryInfo;
  result: messages.EvaluationResult;
  database: DatabaseInfo;
  config: QLConfiguration;
}

/**
 * This mediates between the kind of progress callbacks we want to
 * write (where we *set* current progress position and give
 * `maxSteps`) and the kind vscode progress api expects us to write
 * (which increment progress by a certain amount out of 100%)
 */
function withProgress<R>(
  options: vscode.ProgressOptions,
  task: (
    progress: (p: messages.ProgressMessage) => void,
    token: vscode.CancellationToken
  ) => Thenable<R>
): Thenable<R> {
  let progressAchieved = 0;
  return Window.withProgress(options,
    (progress, token) => {
      return task(p => {
        const { message, step, maxStep } = p;
        const increment = 100 * (step - progressAchieved) / maxStep;
        progressAchieved = step;
        progress.report({ message, increment });
      }, token);
    });
}

/**
 * Checks whether the given database can be upgraded to the given target DB scheme,
 * and whether the user wants to proceed with the upgrade.
 * Reports errors to both the user and the console.
 * @returns the `UpgradeParams` needed to start the upgrade, if the upgrade is possible and was confirmed by the user, or `undefined` otherwise.
 */
async function checkAndConfirmDatabaseUpgrade(qs: qsClient.QueryServerClient, db: DatabaseItem, targetDbScheme: vscode.Uri, upgradesDirectory: vscode.Uri):
  Promise<messages.UpgradeParams | undefined> {
  if (db.contents === undefined || db.contents.dbSchemeUri === undefined) {
    helpers.showAndLogErrorMessage("Database is invalid, and cannot be upgraded.")
    return;
  }
  const params: messages.UpgradeParams = {
    fromDbscheme: db.contents.dbSchemeUri.fsPath,
    toDbscheme: targetDbScheme.fsPath,
    additionalUpgrades: [upgradesDirectory.fsPath]
  };

  let checkUpgradeResult: messages.CheckUpgradeResult;
  try {
    qs.logger.log('Checking database upgrade...');
    checkUpgradeResult = await checkDatabaseUpgrade(qs, params);
  }
  catch (e) {
    helpers.showAndLogErrorMessage(`Database cannot be upgraded: ${e}`);
    return;
  }
  finally {
    qs.logger.log('Done checking database upgrade.')
  }

  const checkedUpgrades = checkUpgradeResult.checkedUpgrades;
  if (checkedUpgrades === undefined) {
    const error = checkUpgradeResult.upgradeError || '[no error message available]';
    await helpers.showAndLogErrorMessage(`Database cannot be upgraded: ${error}`);
    return;
  }

  if (checkedUpgrades.scripts.length === 0) {
    await helpers.showAndLogInformationMessage('Database is already up to date; nothing to do.');
    return;
  }

  let curSha = checkedUpgrades.initialSha;
  let descriptionMessage = '';
  for (const script of checkedUpgrades.scripts) {
    descriptionMessage += `Would perform upgrade: ${script.description}\n`;
    descriptionMessage += `\t-> Compatibility: ${script.compatibility}\n`;
    curSha = script.newSha;
  }

  const targetSha = checkedUpgrades.targetSha;
  if (curSha != targetSha) {
    // Newlines aren't rendered in notifications: https://github.com/microsoft/vscode/issues/48900
    // A modal dialog would be rendered better, but is more intrusive.
    await helpers.showAndLogErrorMessage(`Database cannot be upgraded to the target database scheme.
    Can upgrade from ${checkedUpgrades.initialSha} (current) to ${curSha}, but cannot reach ${targetSha} (target).`);
    // TODO: give a more informative message if we think the DB is ahead of the target DB scheme
    return;
  }

  logger.log(descriptionMessage);
  // Ask the user to confirm the upgrade.
  const shouldUpgrade = await helpers.showBinaryChoiceDialog(`Should the database ${db.databaseUri.fsPath} be upgraded?\n\n${descriptionMessage}`);
  if (shouldUpgrade) {
    return params;
  }
  else {
    logger.log('User cancelled the database upgrade.');
    return;
  }
}

/**
 * Command handler for 'Upgrade Database'.
 * Attempts to upgrade the given database to the given target DB scheme, using the given directory of upgrades.
 * First performs a dry-run and prompts the user to confirm the upgrade.
 * Reports errors during compilation and evaluation of upgrades to the user.
 */
export async function upgradeDatabase(qs: qsClient.QueryServerClient, db: DatabaseItem, targetDbScheme: vscode.Uri, upgradesDirectory: vscode.Uri):
  Promise<messages.RunUpgradeResult | undefined> {
  const upgradeParams = await checkAndConfirmDatabaseUpgrade(qs, db, targetDbScheme, upgradesDirectory);

  if (upgradeParams === undefined) {
    return;
  }

  let compileUpgradeResult: messages.CompileUpgradeResult;
  try {
    compileUpgradeResult = await compileDatabaseUpgrade(qs, upgradeParams);
  }
  catch (e) {
    helpers.showAndLogErrorMessage(`Compilation of database upgrades failed: ${e}`);
    return;
  }
  finally {
    qs.logger.log('Done compiling database upgrade.')
  }

  if (compileUpgradeResult.compiledUpgrades === undefined) {
    const error = compileUpgradeResult.error || '[no error message available]';
    helpers.showAndLogErrorMessage(`Compilation of database upgrades failed: ${error}`);
    return;
  }

  try {
    qs.logger.log('Running the following database upgrade:');
    qs.logger.log(compileUpgradeResult.compiledUpgrades.scripts.map(s => s.description.description).join('\n'));
    return await runDatabaseUpgrade(qs, db, compileUpgradeResult.compiledUpgrades);
  }
  catch (e) {
    helpers.showAndLogErrorMessage(`Database upgrade failed: ${e}`);
    return;
  }
  finally {
    qs.logger.log('Done running database upgrade.')
  }
}

async function checkDatabaseUpgrade(qs: qsClient.QueryServerClient, upgradeParams: messages.UpgradeParams):
  Promise<messages.CheckUpgradeResult> {
  return withProgress({
    location: ProgressLocation.Notification,
    title: "Checking for database upgrades",
    cancellable: true,
  }, (progress, token) => qs.sendRequest(messages.checkUpgrade, upgradeParams, token, progress));
}

async function compileDatabaseUpgrade(qs: qsClient.QueryServerClient, upgradeParams: messages.UpgradeParams):
  Promise<messages.CompileUpgradeResult> {
  const params: messages.CompileUpgradeParams = {
    upgrade: upgradeParams,
    upgradeTempDir: upgradesTmpDir.name
  }

  return withProgress({
    location: ProgressLocation.Notification,
    title: "Compiling database upgrades",
    cancellable: true,
  }, (progress, token) => qs.sendRequest(messages.compileUpgrade, params, token, progress));
}

async function runDatabaseUpgrade(qs: qsClient.QueryServerClient, db: DatabaseItem, upgrades: messages.CompiledUpgrades):
  Promise<messages.RunUpgradeResult> {

  if (db.contents === undefined || db.contents.datasetUri === undefined) {
    throw new Error('Can\'t upgrade an invalid database.');
  }
  const database: messages.Dataset = {
    dbDir: db.contents.datasetUri.fsPath,
    workingSet: 'default'
  };

  const params: messages.RunUpgradeParams = {
    db: database,
    timeoutSecs: qs.config.timeoutSecs,
    toRun: upgrades
  };

  return withProgress({
    location: ProgressLocation.Notification,
    title: "Running database upgrades",
    cancellable: true,
  }, (progress, token) => qs.sendRequest(messages.runUpgrade, params, token, progress));
}

export async function clearCacheInDatabase(qs: qsClient.QueryServerClient, dbItem: DatabaseItem):
  Promise<messages.ClearCacheResult> {
  if (dbItem.contents === undefined) {
    throw new Error('Can\'t clear the cache in an invalid database.');
  }

  const db: messages.Dataset = {
    dbDir: dbItem.contents.datasetUri.fsPath,
    workingSet: 'default',
  };

  const params: messages.ClearCacheParams = {
    dryRun: false,
    db,
  };

  return withProgress({
    location: ProgressLocation.Notification,
    title: "Clearing Cache",
    cancellable: false,
  }, (progress, token) =>
      qs.sendRequest(messages.clearCache, params, token, progress)
  );
}

export async function compileAndRunQueryAgainstDatabase(
  config: QLConfiguration,
  qs: qsClient.QueryServerClient,
  db: DatabaseItem,
  quickEval?: boolean
): Promise<EvaluationInfo> {

  const editor = Window.activeTextEditor;
  // Get the workspace paths
  const workspaceFolders = workspace.workspaceFolders || [];
  let diskWorkspaceFolders: string[] = [];
  for (const workspaceFolder of workspaceFolders) {
    if (workspaceFolder.uri.scheme === "file")
      diskWorkspaceFolders.push(workspaceFolder.uri.fsPath)
  }

  if (editor == undefined) {
    throw new Error('Can\'t run query without an active editor');
  }

  if (editor.document.isDirty) {
    // TODO: add 'always save' button which records preference in configuration
    if (await helpers.showBinaryChoiceDialog('Query file has unsaved changes. Save now?')) {
      editor.document.save();
    }
  }
  if (!db.contents || !db.contents.dbSchemeUri) {
    throw new Error(`Database ${db.databaseUri} does not have a QL database scheme.`);
  }

  // Figure out the library path for the query.
  const packConfig = await cli.resolveLibraryPath(config, diskWorkspaceFolders, editor.document.uri.fsPath, logger);

  const qlProgram: messages.QlProgram = {
    // The project of the current document determines which library path
    // we use. The `libraryPath` field in this server message is relative
    // to the workspace root, not to the project root.
    libraryPath: packConfig.libraryPath,
    // Since we are compiling and running a query against a database,
    // we use the database's DB scheme here instead of the DB scheme
    // from the current document's project.
    dbschemePath: db.contents.dbSchemeUri.fsPath,
    queryPath: editor.document.fileName
  };
  let quickEvalPosition: messages.Position | undefined;
  if (quickEval) {
    const pos = editor.selection.start;
    const posEnd = editor.selection.end;
    // Convert from 0-based to 1-based line and column numbers.
    quickEvalPosition = {
      fileName: editor.document.fileName,
      line: pos.line + 1, column: pos.character + 1,
      endLine: posEnd.line + 1, endColumn: posEnd.character + 1
    }
  }

  // Read the query metadata if possible, to use in the UI.
  let metadata: cli.QueryMetadata | undefined;
  try {
    metadata = await cli.resolveMetadata(qs.config, qlProgram.queryPath, logger);
  } catch (_) {
    // Ignore errors and provide no metadata.
  }
  const query = new QueryInfo(qlProgram, db, quickEvalPosition, metadata);
  const result = await query.compileAndRun(qs);

  return {
    query,
    result,
    database: {
      name: db.name,
      databaseUri: db.databaseUri.toString(true)
    },
    config: qs.config,
  };
}
