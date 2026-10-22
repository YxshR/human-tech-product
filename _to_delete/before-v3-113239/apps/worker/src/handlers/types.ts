import type { JobRunner } from '@humantech/jobs';
import type { FileStorage } from '@humantech/storage';
import type { Mailer } from '../mailer';

export interface Deps { mailer: Mailer; storage: FileStorage; webBaseUrl: string }
export type Register = (runner: JobRunner, deps: Deps) => JobRunner;
