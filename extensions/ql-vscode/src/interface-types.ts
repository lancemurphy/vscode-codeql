import { FivePartLocation } from 'semmle-bqrs';
import * as Sarif from 'sarif';

export interface DatabaseInfo {
  name: string;
  databaseUri: string;
}

export interface PreviousExecution {
  queryName: string;
  time: string;
  databaseName: string;
  durationSeconds: number;
}

export interface Interpretation {
  sourceLocationPrefix: string;
  sarif: Sarif.Log;
}

export interface IntoResultsViewMsg {
  t: 'setState';
  resultsPath: string;
  interpretation: undefined | Interpretation;
  database: DatabaseInfo;
};

export interface FromResultsViewMsg {
  t: 'viewSourceFile';
  loc: FivePartLocation;
  databaseUri: string;
};
