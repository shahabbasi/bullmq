import { toString } from 'lodash';
import { JobJson } from './job';
import {
  SandboxedJob,
  ParentCommand,
  ParentMessage,
  ChildCommand,
} from '../interfaces';

import { childSend } from '../utils';

enum ChildStatus {
  Idle,
  Started,
  Terminating,
  Errored,
}

/*
 * ChildProcessor
 *
 * This class acts as the interface between a child process and its parent process
 * so that jobs can be processed in different processes than the parent.
 *
 */
export class ChildProcessor {
  public status: ChildStatus;
  public processor: (job: SandboxedJob, token?: string) => Promise<any>;
  public currentJobPromise: Promise<unknown> | undefined;

  protected callProcessJob(job: SandboxedJob, token?: string) {
    return this.processor(job, token);
  }

  public run() {
    process.on('message', this.messageHandler.bind(this));

    process.on('SIGTERM', () => this.waitForCurrentJobAndExit());
    process.on('SIGINT', () => this.waitForCurrentJobAndExit());

    process.on('uncaughtException', async (err: Error) => {
      if (!err.message) {
        err = new Error(toString(err));
      }
      await childSend(process, {
        cmd: ParentCommand.Failed,
        value: err,
      });

      throw err;
    });
  }

  protected async messageHandler(msg: ParentMessage) {
    {
      try {
        switch (msg.cmd) {
          case ChildCommand.Init:
            await this.init(msg.value);
            break;
          case ChildCommand.Start:
            await this.start(msg.job);
            break;
          case ChildCommand.Stop:
            break;
        }
      } catch (err) {
        console.error('Error handling parent message');
      }
    }
  }

  public async init(processorFile: string) {
    let required:
      | { default?: (job: SandboxedJob, token: string) => Promise<any> }
      | ((job: SandboxedJob, token: string) => Promise<any>);

    try {
      required = require(processorFile);
    } catch (err) {
      this.status = ChildStatus.Errored;
      return childSend(process, {
        cmd: ParentCommand.InitFailed,
        err: <Error>err,
      });
    }

    if (typeof required == 'object') {
      // support es2015 module.
      this.processor = required.default;
    } else {
      this.processor = required;
    }

    this.status = ChildStatus.Idle;
    await childSend(process, {
      cmd: ParentCommand.InitCompleted,
    });
  }

  public async start(jobJson: JobJson): Promise<void> {
    if (this.status !== ChildStatus.Idle) {
      return childSend(process, {
        cmd: ParentCommand.Error,
        err: new Error('cannot start a not idling child process'),
      });
    }
    this.status = ChildStatus.Started;
    this.currentJobPromise = (async () => {
      try {
        const job = wrapJob(jobJson);
        const result = await this.callProcessJob(job);
        await childSend(process, {
          cmd: ParentCommand.Completed,
          value: result,
        });
      } catch (err) {
        await childSend(process, {
          cmd: ParentCommand.Failed,
          value: !(<Error>err).message ? new Error(<any>err) : err,
        });
      } finally {
        this.status = ChildStatus.Idle;
        this.currentJobPromise = undefined;
      }
    })();
  }

  public async stop() {}

  async waitForCurrentJobAndExit() {
    this.status = ChildStatus.Terminating;
    try {
      await this.currentJobPromise;
    } finally {
      process.exit(process.exitCode || 0);
    }
  }
}

// https://stackoverflow.com/questions/18391212/is-it-not-possible-to-stringify-an-error-using-json-stringify
if (!('toJSON' in Error.prototype)) {
  Object.defineProperty(Error.prototype, 'toJSON', {
    value: function () {
      const alt: any = {};
      const _this = this;

      Object.getOwnPropertyNames(_this).forEach(function (key) {
        alt[key] = _this[key];
      }, this);

      return alt;
    },
    configurable: true,
    writable: true,
  });
}

/**
 * Enhance the given job argument with some functions
 * that can be called from the sandboxed job processor.
 *
 * Note, the `job` argument is a JSON deserialized message
 * from the main node process to this forked child process,
 * the functions on the original job object are not in tact.
 * The wrapped job adds back some of those original functions.
 */
function wrapJob(job: JobJson): SandboxedJob {
  let progressValue = job.progress;

  const updateProgress = async (progress: number | object) => {
    // Locally store reference to new progress value
    // so that we can return it from this process synchronously.
    progressValue = progress;
    // Send message to update job progress.
    await childSend(process, {
      cmd: ParentCommand.Progress,
      value: progress,
    });
  };

  const progress = (progress?: number | object) => {
    console.warn(
      [
        'BullMQ: DEPRECATION WARNING! progress function in sandboxed processor is deprecated. This will',
        'be removed in the next major release, you should use updateProgress method instead.',
      ].join(' '),
    );

    if (progress) {
      return updateProgress(progress);
    } else {
      // Return the last known progress value.
      return progressValue;
    }
  };

  return {
    ...job,
    data: JSON.parse(job.data || '{}'),
    opts: job.opts,
    returnValue: JSON.parse(job.returnvalue || '{}'),
    /*
     * Emulate the real job `progress` function.
     * If no argument is given, it behaves as a sync getter.
     * If an argument is given, it behaves as an async setter.
     */
    progress,
    /*
     * Emulate the real job `updateProgress` function, should works as `progress` function.
     */
    updateProgress,
    /*
     * Emulate the real job `log` function.
     */
    log: async (row: any) => {
      childSend(process, {
        cmd: ParentCommand.Log,
        value: row,
      });
    },
  };
}
