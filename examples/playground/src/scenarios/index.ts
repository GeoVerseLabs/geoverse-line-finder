import { gpfScenario } from './gpf';
import { gridScenario } from './grid';
import { multiLevelScenario } from './multi-level';
import type { Scenario } from './types';
import { warehouseScenario } from './warehouse';

export const scenarios: Scenario<unknown>[] = [
  warehouseScenario as Scenario<unknown>,
  multiLevelScenario as Scenario<unknown>,
  gridScenario as Scenario<unknown>,
  gpfScenario as Scenario<unknown>,
];

export type { Scenario, ScenarioFeatures, ScenarioLevels, ScenarioPreset } from './types';
