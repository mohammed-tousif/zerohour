/**
 * Demo video storyboard. Each scene = narration (Windows text-to-speech) + a
 * clip cut from one of the recorded browser pages, starting at a named mark.
 * No third-party trademarks, no music.
 */
export type PageName = 'slides' | 'desk' | 'phone';

export interface Scene {
  id: string;
  page: PageName;
  /** Event mark (logged by the recorder) the clip starts at */
  mark: string;
  /** Seconds after the mark to start (negative = before) */
  offset?: number;
  /** Hold the clip at least this long (silence after the narration) */
  minSeconds?: number;
  text: string;
}

export const SCENES: Scene[] = [
  { id: '01-title', page: 'slides', mark: 'title', text: 'Every year, exam results websites crash the minute results are announced. This is Zero Hour: exam results that cannot crash.' },
  { id: '02-idea', page: 'slides', mark: 'diagram', text: 'Days before results day, every result is encrypted with its own key and published as a tiny file, and each phone saves its own file early. At zero hour, the only thing anyone downloads is a thirty two byte key, and only after two of three officials approve. It is fully serverless on A W S: S3, Step Functions, Lambda, DynamoDB, K M S and API Gateway.' },
  { id: '03-publish', page: 'slides', mark: 'publish', text: 'Here the exam office publishes fifty thousand synthetic results. A Step Functions Distributed Map reads the file from S3 and fans out to Lambda, which encrypts every result and writes it under S3 Object Lock. A manifest records a fingerprint of every file.' },
  { id: '04-dashboard', page: 'desk', mark: 'dash-locked', offset: 1, minSeconds: 7, text: 'The control room shows fifty thousand results staged and locked, with a countdown to release time.' },
  { id: '05-student', page: 'phone', mark: 'phone-form', offset: -0.5, text: 'A student opens the app once and enters their seat number and date of birth. Their encrypted result is now saved on the phone. Nobody can read it yet, because the key does not exist anywhere public.' },
  { id: '06-zero-hour', page: 'phone', mark: 'phone-waiting', text: 'Publishing also started a Lambda durable function, asleep until release time and costing nothing. At zero hour it wakes up by itself and opens approvals.' },
  { id: '07-approve-1', page: 'desk', mark: 'approver1', minSeconds: 10, text: 'The registrar opens a one time link and approves.' },
  { id: '08-still-locked', page: 'phone', mark: 'after-approve1', text: 'One approval is not enough. The result stays locked.' },
  { id: '09-approve-2', page: 'desk', mark: 'approver2', minSeconds: 9, text: 'The controller of examinations approves. That resumes the Step Functions workflow, and a Lambda publishes the key.' },
  { id: '10-decrypt', page: 'phone', mark: 'key-moment', offset: -1, minSeconds: 9, text: 'Every waiting phone picks up the key and decrypts its result locally, in a few milliseconds.' },
  { id: '11-released', page: 'desk', mark: 'dash-released', text: 'The control room confirms the release. Staging fifty thousand results cost about twenty six cents, and results day fits inside the content delivery network free tier.' },
  { id: '12-close', page: 'slides', mark: 'closing', text: 'Publish early, encrypted. Release only a key, on approval. Zero Hour.' },
];
