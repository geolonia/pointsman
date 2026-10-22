// Every fact module in this repository, chosen for the Worker tests (the
// Worker itself chooses them in src/index.ts from generated/modules.ts).
import { useFactModules } from '../../src/modules/registry';
import modules from '../../generated/modules';

useFactModules(modules);
