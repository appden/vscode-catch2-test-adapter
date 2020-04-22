import * as fs from 'fs';
import { inspect, promisify } from 'util';
import { TestEvent } from 'vscode-test-adapter-api';
import * as xml2js from 'xml2js';

import * as c2fs from '../FSWrapper';
import { RunnableSuiteProperties } from '../RunnableSuiteProperties';
import { AbstractRunnable } from '../AbstractRunnable';
import { Suite } from '../Suite';
import { Catch2Test } from './Catch2Test';
import { SharedVariables } from '../SharedVariables';
import { RunningTestExecutableInfo, ProcessResult } from '../RunningTestExecutableInfo';
import { AbstractTest } from '../AbstractTest';
import { Version } from '../Util';
import { TestGrouping } from '../TestGroupingInterface';

interface XmlObject {
  [prop: string]: any; //eslint-disable-line
}

export class Catch2Suite extends AbstractRunnable {
  public constructor(
    shared: SharedVariables,
    rootSuite: Suite,
    label: string,
    desciption: string | undefined,
    execInfo: RunnableSuiteProperties,
    private readonly _catch2Version: Version,
  ) {
    super(shared, rootSuite, label, desciption, execInfo, 'Catch2', Promise.resolve(_catch2Version));
  }

  private getTestGrouping(): TestGrouping {
    //TODO
    if (this.execInfo.testGrouping) {
      return this.execInfo.testGrouping;
    } else {
      return { groupByTags: { tags: [] } };
    }
  }

  private _reloadFromString(testListOutput: string): void {
    const lines = testListOutput.split(/\r?\n/);

    const startRe = /Matching test cases:/;
    const endRe = /[0-9]+ matching test cases?/;

    let i = 0;

    while (i < lines.length) {
      const m = lines[i++].match(startRe);
      if (m !== null) break;
    }

    if (i >= lines.length) {
      this._shared.log.error('Wrong test list output format #1', testListOutput);
      throw Error('Wrong test list output format');
    }

    while (i < lines.length) {
      const m = lines[i].match(endRe);
      if (m !== null) break;

      if (!lines[i].startsWith('  ')) this._shared.log.error('Wrong test list output format', i, lines);

      if (lines[i].startsWith('    ')) {
        this._shared.log.warn('Probably too long test name', i, lines);
        this.children = [];
        this._addError(
          this,
          [
            '⚠️ Probably too long test name or the test name starts with space characters!',
            '🛠 - Try to define `CATCH_CONFIG_CONSOLE_WIDTH 300` before `catch2.hpp` is included.',
            '🛠 - Remove whitespace characters from the beggining of test "' + lines[i].substr(2) + '"',
          ].join('\n'),
        );
        return;
      }
      const testName = lines[i++].substr(2);

      let filePath: string | undefined = undefined;
      let line: number | undefined = undefined;
      {
        const fileLine = lines[i++].substr(4);
        const match = fileLine.match(/(?:(.+):([0-9]+)|(.+)\(([0-9]+)\))/);

        if (match && match.length == 5) {
          const matchedPath = match[1] ? match[1] : match[3];
          filePath = this._findFilePath(matchedPath);
          line = Number(match[2] ? match[2] : match[4]) - 1;
        } else {
          this._shared.log.error('Could not find catch2 file info', lines);
        }
      }

      let description = lines[i++].substr(4);
      if (description.startsWith('(NO DESCRIPTION)')) description = '';

      const tags: string[] = [];
      if (i < lines.length && lines[i].startsWith('      [')) {
        const matches = lines[i].match(/\[[^\[\]]+\]/g);
        if (matches) matches.forEach(t => tags.push(t.substring(1, t.length - 1)));
        ++i;
      }

      this.createSubtreeAndAddTest(
        testName,
        testName,
        filePath,
        tags,
        this.getTestGrouping(),
        (parent: Suite, old: AbstractTest | undefined) =>
          new Catch2Test(
            this._shared,
            this,
            parent,
            this._catch2Version,
            testName,
            tags,
            filePath,
            line,
            description,
            old as Catch2Test | undefined,
          ),
      );
    }

    if (i >= lines.length) this._shared.log.error('Wrong test list output format #2', lines);
  }

  protected async _reloadChildren(): Promise<void> {
    const cacheFile = this.execInfo.path + '.cache.txt';

    if (this._shared.enabledTestListCaching) {
      try {
        const cacheStat = await promisify(fs.stat)(cacheFile);
        const execStat = await promisify(fs.stat)(this.execInfo.path);

        if (cacheStat.size > 0 && cacheStat.mtime > execStat.mtime) {
          this._shared.log.info('loading from cache: ', cacheFile);
          const content = await promisify(fs.readFile)(cacheFile, 'utf8');

          if (content === '') {
            this._shared.log.debug('loading from cache failed because file is empty');
          } else {
            this._reloadFromString(content);

            return;
          }
        }
      } catch (e) {
        this._shared.log.warn('coudnt use cache', e);
      }
    }

    const catch2TestListOutput = await c2fs.spawnAsync(
      this.execInfo.path,
      this.execInfo.prependTestListingArgs.concat([
        '[.],*',
        '--verbosity',
        'high',
        '--list-tests',
        '--use-colour',
        'no',
      ]),
      this.execInfo.options,
      30000,
    );

    if (catch2TestListOutput.stderr && !this.execInfo.ignoreTestEnumerationStdErr) {
      this._shared.log.warn('reloadChildren -> catch2TestListOutput.stderr', catch2TestListOutput);
      this._addUnexpectedStdError(catch2TestListOutput.stdout, catch2TestListOutput.stderr);
      return Promise.resolve();
    }

    if (catch2TestListOutput.stdout.length === 0) {
      this._shared.log.debug(catch2TestListOutput);
      throw Error('stoud is empty');
    }

    this._reloadFromString(catch2TestListOutput.stdout);

    if (this._shared.enabledTestListCaching) {
      return promisify(fs.writeFile)(cacheFile, catch2TestListOutput.stdout).catch(err =>
        this._shared.log.warn('couldnt write cache file:', err),
      );
    }
  }

  protected _getRunParams(childrenToRun: ReadonlyArray<Catch2Test>): string[] {
    const execParams: string[] = [];

    const testNames = childrenToRun.map(c => c.getEscapedTestName());
    execParams.push(testNames.join(','));

    execParams.push('--reporter');
    execParams.push('xml');
    execParams.push('--durations');
    execParams.push('yes');

    if (this._shared.isNoThrow) execParams.push('--nothrow');

    if (this._shared.rngSeed !== null) {
      execParams.push('--order');
      execParams.push('rand');
      execParams.push('--rng-seed');
      execParams.push(this._shared.rngSeed.toString());
    }

    return execParams;
  }

  protected _handleProcess(runInfo: RunningTestExecutableInfo): Promise<void> {
    const data = new (class {
      public stdoutBuffer = '';
      public stderrBuffer = '';
      public inTestCase = false;
      public currentChild: AbstractTest | undefined = undefined;
      public route: Suite[] = [];
      public beforeFirstTestCase = true;
      public rngSeed: number | undefined = undefined;
      public unprocessedXmlTestCases: [string, string][] = [];
      public processedTestCases: AbstractTest[] = [];
    })();

    const testCaseTagRe = /<TestCase(?:\s+[^\n\r]+)?>/;

    return new Promise<ProcessResult>(resolve => {
      const chunks: string[] = [];
      const processChunk = (chunk: string): void => {
        chunks.push(chunk);
        data.stdoutBuffer = data.stdoutBuffer + chunk;
        let invariant = 99999;
        do {
          if (!data.inTestCase) {
            const b = data.stdoutBuffer.indexOf('<TestCase');
            if (b == -1) return;

            const m = data.stdoutBuffer.match(testCaseTagRe);
            if (m == null || m.length != 1) return;

            data.inTestCase = true;

            let name = '';
            new xml2js.Parser({ explicitArray: true }).parseString(
              m[0] + '</TestCase>',
              (err: Error, result: XmlObject) => {
                if (err) {
                  this._shared.log.exception(err);
                  throw err;
                } else {
                  name = result.TestCase.$.name;
                }
              },
            );

            if (data.beforeFirstTestCase) {
              const ri = data.stdoutBuffer.match(/<Randomness\s+seed="([0-9]+)"\s*\/?>/);
              if (ri != null && ri.length == 2) {
                data.rngSeed = Number(ri[1]);
              }
            }

            data.beforeFirstTestCase = false;

            const test = this.findTest(v => v.testNameInOutput == name);

            if (test) {
              const route = [...test.route()];
              this.sendMinimalEventsIfNeeded(data.route, route);
              data.route = route;

              data.currentChild = test;
              this._shared.log.info('Test', data.currentChild.testName, 'has started.');
              this._shared.testStatesEmitter.fire(data.currentChild.getStartEvent());
            } else {
              this._shared.log.info('TestCase not found in children', name);
            }

            data.stdoutBuffer = data.stdoutBuffer.substr(b);
          } else {
            const endTestCase = '</TestCase>';
            const b = data.stdoutBuffer.indexOf(endTestCase);
            if (b == -1) return;

            const testCaseXml = data.stdoutBuffer.substring(0, b + endTestCase.length);

            if (data.currentChild !== undefined) {
              this._shared.log.info('Test ', data.currentChild.testName, 'has finished.');
              try {
                const ev = data.currentChild.parseAndProcessTestCase(
                  testCaseXml,
                  data.rngSeed,
                  runInfo,
                  data.stderrBuffer,
                );

                this._shared.testStatesEmitter.fire(ev);

                data.processedTestCases.push(data.currentChild);
              } catch (e) {
                this._shared.log.error('parsing and processing test', e, data, chunks, testCaseXml);
                this._shared.testStatesEmitter.fire({
                  type: 'test',
                  test: data.currentChild,
                  state: 'errored',
                  message: [
                    '😱 Unexpected error under parsing output !! Error: ' + inspect(e),
                    'Consider opening an issue: https://github.com/matepek/vscode-catch2-test-adapter/issues/new/choose',
                    '',
                    'stdout >>>' + data.stdoutBuffer + '<<<',
                    '',
                    'stderr >>>' + data.stderrBuffer + '<<<',
                  ].join('\n'),
                });
              }
            } else {
              this._shared.log.info('<TestCase> found without TestInfo', this, testCaseXml);
              data.unprocessedXmlTestCases.push([testCaseXml, data.stderrBuffer]);
            }

            data.inTestCase = false;
            data.currentChild = undefined;
            // do not clear data.route
            data.stdoutBuffer = data.stdoutBuffer.substr(b + endTestCase.length);
            data.stderrBuffer = '';
          }
        } while (data.stdoutBuffer.length > 0 && --invariant > 0);
        if (invariant == 0) {
          this._shared.log.error('invariant==0', this, runInfo, data, chunks);
          resolve(ProcessResult.error('Possible infinite loop of this extension'));
          runInfo.killProcess();
        }
      };

      runInfo.process.stdout!.on('data', (chunk: Uint8Array) => processChunk(chunk.toLocaleString()));
      runInfo.process.stderr!.on('data', (chunk: Uint8Array) => (data.stderrBuffer += chunk.toLocaleString()));

      runInfo.process.once('close', (code: number | null, signal: string | null) => {
        if (runInfo.isCancelled) {
          resolve(ProcessResult.ok());
        } else {
          if (code !== null && code !== undefined) resolve(ProcessResult.createFromErrorCode(code));
          else if (signal !== null && signal !== undefined) resolve(ProcessResult.createFromSignal(signal));
          else resolve(ProcessResult.error('unknown sfngvdlfkxdvgn'));
        }
      });
    })
      .catch((reason: Error) => {
        // eslint-disable-next-line
        if ((reason as any).code === undefined) this._shared.log.exception(reason);

        return new ProcessResult(reason);
      })
      .then((result: ProcessResult) => {
        result.error && this._shared.log.info(result.error.toString(), result, runInfo, this, data);

        if (data.inTestCase) {
          if (data.currentChild !== undefined) {
            this._shared.log.info('data.currentChild !== undefined', data);
            let ev: TestEvent;

            if (runInfo.isCancelled) {
              ev = data.currentChild.getCancelledEvent(data.stdoutBuffer);
            } else if (runInfo.timeout !== null) {
              ev = data.currentChild.getTimeoutEvent(runInfo.timeout);
            } else {
              ev = data.currentChild.getFailedEventBase();

              ev.message = '😱 Unexpected error !!';

              if (result.error) {
                ev.state = 'errored';
                ev.message += '\n' + result.error.message;
              }

              ev.message += `\n\nstdout >>>${data.stdoutBuffer}<<<`;
              ev.message += `\n\nstderr >>>${data.stderrBuffer}<<<`;
            }

            data.currentChild.lastRunEvent = ev;
            this._shared.testStatesEmitter.fire(ev);
          } else {
            this._shared.log.warn('data.inTestCase: ', data);
          }
        }

        this.sendMinimalEventsIfNeeded(data.route, []);
        data.route = [];

        const isTestRemoved =
          runInfo.timeout === null &&
          !runInfo.isCancelled &&
          result.error === undefined &&
          data.processedTestCases.length < runInfo.childrenToRun.length;

        if (data.unprocessedXmlTestCases.length > 0 || isTestRemoved) {
          new Promise<void>((resolve, reject) => {
            this._shared.loadWithTaskEmitter.fire(() => {
              return this.reloadTests(this._shared.taskPool).then(resolve, reject);
            });
          }).then(
            () => {
              // we have test results for the newly detected tests
              // after reload we can set the results
              const events: TestEvent[] = [];

              for (let i = 0; i < data.unprocessedXmlTestCases.length; i++) {
                const [testCaseXml, stderr] = data.unprocessedXmlTestCases[i];

                const m = testCaseXml.match(testCaseTagRe);
                if (m == null || m.length != 1) break;

                let name: string | undefined = undefined;
                new xml2js.Parser({ explicitArray: true }).parseString(
                  m[0] + '</TestCase>',
                  (err: Error, result: XmlObject) => {
                    if (err) {
                      this._shared.log.exception(err);
                    } else {
                      name = result.TestCase.$.name;
                    }
                  },
                );
                if (name === undefined) break;

                const currentChild = this.findTest(v => v.testNameInOutput === name);

                if (currentChild === undefined) break;

                try {
                  const ev = currentChild.parseAndProcessTestCase(testCaseXml, data.rngSeed, runInfo, stderr);
                  events.push(ev);
                } catch (e) {
                  this._shared.log.error('parsing and processing test', e, testCaseXml);
                }
              }
              events.length && this._shared.sendTestEventEmitter.fire(events);
            },
            (reason: Error) => {
              // Suite possibly deleted: It is a dead suite.
              this._shared.log.error('reloading-error: ', reason);
            },
          );
        }
      });
  }
}
