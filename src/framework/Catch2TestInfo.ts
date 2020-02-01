import { TestEvent } from 'vscode-test-adapter-api';
import * as xml2js from 'xml2js';
import { AbstractTestInfo } from '../AbstractTestInfo';
import { inspect } from 'util';
import { SharedVariables } from '../SharedVariables';
import { RunningTestExecutableInfo } from '../RunningTestExecutableInfo';
import { TestEventBuilder } from '../TestEventBuilder';

interface XmlObject {
  [prop: string]: any; //eslint-disable-line
}

interface Frame {
  name: string;
  filename: string;
  line: number;
}

export class Catch2Section implements Frame {
  public constructor(name: string, filename: string, line: number) {
    this.name = name;
    // some debug adapter on ubuntu starts debug session in shell,
    // this prevents the SECTION("`pwd`") to be executed
    this.name = this.name.replace(/`/g, '\\`');

    this.filename = filename;
    this.line = line;
  }

  public readonly name: string;
  public readonly filename: string;
  public readonly line: number;
  public readonly children: Catch2Section[] = [];
  public failed: boolean = false;
}

export class Catch2TestInfo extends AbstractTestInfo {
  public constructor(
    shared: SharedVariables,
    id: string | undefined,
    testNameAsId: string,
    catch2Description: string,
    tags: string[],
    file: string,
    line: number,
    sections?: Catch2Section[],
  ) {
    super(
      shared,
      id,
      testNameAsId,
      testNameAsId,
      tags.some((v: string) => {
        return v.startsWith('[.') || v == '[hide]';
      }) || testNameAsId.startsWith('./'),
      file,
      line,
      tags.join(''),
      [tags.length > 0 ? 'Tags: ' + tags.join('') : '', catch2Description ? 'Description: ' + catch2Description : '']
        .filter(v => v.length)
        .join('\n'),
    );
    this._sections = sections;
  }

  private _sections: undefined | Catch2Section[];

  public get sections(): undefined | Catch2Section[] {
    return this._sections;
  }

  public getEscapedTestName(): string {
    /* ',' has special meaning */
    let t = this.testNameAsId;
    t = t.replace(/,/g, '\\,');
    t = t.replace(/\[/g, '\\[');
    t = t.replace(/\*/g, '\\*');
    t = t.replace(/`/g, '\\`');
    if (t.startsWith(' ')) t = '*' + t.trimLeft();
    return t;
  }

  public getDebugParams(breakOnFailure: boolean): string[] {
    const debugParams: string[] = [this.getEscapedTestName(), '--reporter', 'console'];
    if (breakOnFailure) debugParams.push('--break');
    return debugParams;
  }

  public parseAndProcessTestCase(
    xmlStr: string,
    rngSeed: number | undefined,
    runInfo: RunningTestExecutableInfo,
  ): TestEvent {
    if (runInfo.timeout !== null) {
      const ev = this.getTimeoutEvent(runInfo.timeout);
      this.lastRunEvent = ev;
      return ev;
    }

    let res: XmlObject = {};
    new xml2js.Parser({ explicitArray: true }).parseString(xmlStr, (err: Error, result: XmlObject) => {
      if (err) {
        throw Error(inspect(err));
      } else {
        res = result;
      }
    });

    const testEventBuilder = new TestEventBuilder(this);

    if (rngSeed) testEventBuilder.appendMessage(`🔀 Randomness seeded to: ${rngSeed.toString()}`, 0);

    this._processXmlTagTestCaseInner(res.TestCase, testEventBuilder);

    const testEvent = testEventBuilder.build();

    this.lastRunEvent = testEvent;

    return testEvent;
  }

  private _processXmlTagTestCaseInner(testCase: XmlObject, testEventBuilder: TestEventBuilder): void {
    if (testCase.OverallResult[0].$.hasOwnProperty('durationInSeconds')) {
      this.lastRunMilisec = Number(testCase.OverallResult[0].$.durationInSeconds) * 1000;
      testEventBuilder.setDurationMilisec(this.lastRunMilisec);
    }

    testEventBuilder.appendMessage(testCase._, 0);

    const title: Catch2Section = new Catch2Section(testCase.$.name, testCase.$.filename, testCase.$.line);

    this._processTags(testCase, title, [], testEventBuilder);

    this._processXmlTagSections(testCase, title, [], testEventBuilder, title);

    this._sections = title.children;

    if (testCase.OverallResult[0].StdOut) {
      testEventBuilder.appendMessage('⬇ std::cout:', 0);
      for (let i = 0; i < testCase.OverallResult[0].StdOut.length; i++)
        testEventBuilder.appendMessage(testCase.OverallResult[0].StdOut[i], 1);
      testEventBuilder.appendMessage('⬆ std::cout', 0);
    }

    if (testCase.OverallResult[0].StdErr) {
      testEventBuilder.appendMessage('⬇ std::err:', 0);
      for (let i = 0; i < testCase.OverallResult[0].StdErr.length; i++)
        testEventBuilder.appendMessage(testCase.OverallResult[0].StdErr[i], 1);
      testEventBuilder.appendMessage('⬆ std::err', 0);
    }

    if (testCase.OverallResult[0].$.success === 'true') {
      testEventBuilder.setState('passed');
    }

    if (this._sections.length) {
      let failedBranch = 0;
      let succBranch = 0;

      const traverse = (section: Catch2Section): void => {
        if (section.children.length === 0) {
          section.failed ? ++failedBranch : ++succBranch;
        } else {
          for (let i = 0; i < section.children.length; ++i) {
            traverse(section.children[i]);
          }
        }
      };

      this._sections.forEach(section => traverse(section));

      const branchMsg = (failedBranch ? '✘' + failedBranch + '|' : '') + '✔︎' + succBranch;

      testEventBuilder.appendDescription(` [${branchMsg}]`);
      testEventBuilder.appendTooltip(`ᛦ ${branchMsg} branches`);
    }
  }

  private static readonly _expectedPropertyNames = new Set([
    '_',
    '$',
    'Section',
    'Info',
    'Warning',
    'Failure',
    'Expression',
    'Exception',
    'OverallResult',
    'OverallResults',
    'FatalErrorCondition',
    'BenchmarkResults',
  ]);

  private _processTags(xml: XmlObject, title: Frame, stack: Catch2Section[], testEventBuilder: TestEventBuilder): void {
    {
      Object.getOwnPropertyNames(xml).forEach(n => {
        if (!Catch2TestInfo._expectedPropertyNames.has(n)) {
          this._shared.log.error('unexpected Catch2 tag', n);
          testEventBuilder.appendMessage('unexpected Catch2 tag:' + n, 0);
          testEventBuilder.setState('errored');
        }
      });
    }

    testEventBuilder.appendMessage(xml._, 0);

    try {
      if (xml.Info) {
        testEventBuilder.appendMessage('⬇ Info:', 0);
        for (let i = 0; i < xml.Info.length; i++) testEventBuilder.appendMessage(xml.Info[i], 1);
        testEventBuilder.appendMessage('⬆ Info', 0);
      }
    } catch (e) {
      this._shared.log.exception(e);
    }

    try {
      if (xml.Warning) {
        testEventBuilder.appendMessage('⬇ Warning:', 0);
        for (let i = 0; i < xml.Warning.length; i++)
          testEventBuilder.appendMessageWithDecorator(Number(xml.Warning[i].$.line) - 1, xml.Warning[i], 1);
        testEventBuilder.appendMessage('⬆ Warning', 0);
      }
    } catch (e) {
      this._shared.log.exception(e);
    }

    try {
      if (xml.Failure) {
        testEventBuilder.appendMessage('⬇ Failure:', 0);
        for (let i = 0; i < xml.Failure.length; i++)
          testEventBuilder.appendMessageWithDecorator(Number(xml.Failure[i].$.line) - 1, xml.Failure[i], 1);
        testEventBuilder.appendMessage('⬆ Failure', 0);
      }
    } catch (e) {
      this._shared.log.exception(e);
    }

    try {
      if (xml.BenchmarkResults) {
        testEventBuilder.appendMessage('⬇ BenchmarkResults (experimental):', 0);
        for (let i = 0; i < xml.BenchmarkResults.length; i++) {
          const b = xml.BenchmarkResults[i];
          testEventBuilder.appendMessage(
            Object.keys(b.$)
              .map(key => `${key}: ${b.$[key]}`)
              .join('\n'),
            1,
          );

          testEventBuilder.appendMessage('Mean:', 1);
          for (let j = 0; b.mean && j < b.mean.length; ++j) {
            testEventBuilder.appendMessage(
              Object.keys(b.mean[j].$)
                .map(key => `${key}: ${b.mean[j].$[key]} ns`)
                .join('\n'),
              2,
            );
          }

          testEventBuilder.appendMessage('Standard Deviation:', 1);
          for (let j = 0; b.standardDeviation && j < b.standardDeviation.length; ++j) {
            testEventBuilder.appendMessage(
              Object.keys(b.standardDeviation[j].$)
                .map(key => `${key}: ${b.standardDeviation[j].$[key]} ns`)
                .join('\n'),
              2,
            );
          }

          testEventBuilder.appendMessage('Outliers:', 1);
          for (let j = 0; b.outliers && j < b.outliers.length; ++j) {
            testEventBuilder.appendMessage(
              Object.keys(b.outliers[j].$)
                .map(key => `${key}: ${b.outliers[j].$[key]} ns`)
                .join('\n'),
              2,
            );
          }
        }
        testEventBuilder.appendMessage('⬆ BenchmarkResults', 0);
      }
    } catch (e) {
      this._shared.log.exception(e);
    }

    try {
      if (xml.Expression) {
        for (let j = 0; j < xml.Expression.length; ++j) {
          const expr = xml.Expression[j];
          const message =
            '❕Original:  ' +
            expr.Original.map((x: string) => x.trim()).join('; ') +
            '\n' +
            '❗️Expanded:  ' +
            expr.Expanded.map((x: string) => x.trim()).join('; ');

          testEventBuilder.appendMessage(message, 1);
          testEventBuilder.appendDecorator(
            Number(expr.$.line) - 1,
            '⬅ ' + expr.Expanded.map((x: string) => x.trim()).join(' | '),
            message,
          );
        }
      }
    } catch (e) {
      this._shared.log.exception(e);
    }

    try {
      for (let j = 0; xml.Exception && j < xml.Exception.length; ++j) {
        testEventBuilder.appendMessageWithDecorator(
          Number(xml.Exception[j].$.line) - 1,
          'Exception were thrown: "' + xml.Exception[j]._.trim() + '"',
          0,
        );
      }
    } catch (e) {
      this._shared.log.exception(e);
    }

    try {
      if (xml.FatalErrorCondition) {
        testEventBuilder.appendMessage('⬇ FatalErrorCondition:', 0);
        for (let j = 0; j < xml.FatalErrorCondition.length; ++j) {
          testEventBuilder.appendMessageWithDecorator(
            Number(xml.FatalErrorCondition[j].$.line) - 1,
            xml.FatalErrorCondition[j]._,
            0,
          );
        }
        testEventBuilder.appendMessage('⬆ FatalErrorCondition', 0);
      }
    } catch (error) {
      this._shared.log.exception(error);
      testEventBuilder.appendMessage('Unknown fatal error: ' + inspect(error), 0);
    }
  }

  private _processXmlTagSections(
    xml: XmlObject,
    title: Frame,
    stack: Catch2Section[],
    testEventBuilder: TestEventBuilder,
    parentSection: Catch2Section,
  ): void {
    for (let j = 0; xml.Section && j < xml.Section.length; ++j) {
      const section = xml.Section[j];

      try {
        let currSection = parentSection.children.find(
          v => v.name === section.$.name && v.filename === section.$.filename && v.line === section.$.line,
        );

        if (currSection === undefined) {
          currSection = new Catch2Section(section.$.name, section.$.filename, section.$.line);
          parentSection.children.push(currSection);
        }

        const isLeaf = section.Section === undefined || section.Section.length === 0;

        if (
          isLeaf &&
          section.OverallResults &&
          section.OverallResults.length > 0 &&
          section.OverallResults[0].$.failures !== '0'
        ) {
          currSection.failed = true;
        }

        const msg =
          '   '.repeat(stack.length) +
          '⮑ ' +
          (isLeaf ? (currSection.failed ? ' ❌ ' : ' ✅ ') : '') +
          `${section.$.name}`;

        testEventBuilder.appendMessage(msg + ` (line:${section.$.line})`, null);

        const currStack = stack.concat(currSection);

        this._processTags(section, title, currStack, testEventBuilder);

        this._processXmlTagSections(section, title, currStack, testEventBuilder, currSection);
      } catch (error) {
        testEventBuilder.appendMessage('Fatal error processing section', 0);
        this._shared.log.exception(error);
      }
    }
  }
}
