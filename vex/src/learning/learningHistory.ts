import * as vscode from 'vscode';

export type QuestionDifficulty = 'easy' | 'medium' | 'hard';

export interface QuestionAttempt {
	timestamp: string;
	question: string;
	concept: string;
	correct: boolean;
	difficulty: QuestionDifficulty;
	filePath: string;
	project?: string;
}

export interface LearnerProfile {
	conceptsUnderstood: string[];
	conceptsFrequentlyMissed: string[];
	recentTopics: string[];
	approximateDifficulty: QuestionDifficulty;
}

const historyKey = 'vex.learningHistory';
const maxStoredAttempts = 200;
const recentAttemptLimit = 40;

export class LearningHistoryStore {
	public constructor(private readonly state: vscode.Memento) {}

	public async record(attempt: QuestionAttempt): Promise<LearnerProfile> {
		const history = this.getAttempts();
		history.push(attempt);
		await this.state.update(historyKey, history.slice(-maxStoredAttempts));
		return this.buildProfile(history);
	}

	public getProfile(): LearnerProfile {
		return this.buildProfile(this.getAttempts());
	}

	private getAttempts(): QuestionAttempt[] {
		return this.state.get<QuestionAttempt[]>(historyKey, []);
	}

	private buildProfile(attempts: QuestionAttempt[]): LearnerProfile {
		const recent = attempts.slice(-recentAttemptLimit);
		const conceptStats = new Map<string, { correct: number; incorrect: number; latest: number }>();
		for (const [index, attempt] of recent.entries()) {
			const concept = attempt.concept.trim();
			if (!concept) {
				continue;
			}
			const stats = conceptStats.get(concept) ?? { correct: 0, incorrect: 0, latest: index };
			attempt.correct ? stats.correct++ : stats.incorrect++;
			stats.latest = index;
			conceptStats.set(concept, stats);
		}

		const conceptsUnderstood = [...conceptStats.entries()]
			.filter(([, stats]) => stats.correct > stats.incorrect && stats.correct >= 2)
			.sort((left, right) => right[1].correct - right[1].incorrect - (left[1].correct - left[1].incorrect))
			.map(([concept]) => concept)
			.slice(0, 8);
		const conceptsFrequentlyMissed = [...conceptStats.entries()]
			.filter(([, stats]) => stats.incorrect > stats.correct && stats.incorrect >= 2)
			.sort((left, right) => right[1].incorrect - right[1].correct - (left[1].incorrect - left[1].correct))
			.map(([concept]) => concept)
			.slice(0, 8);
		const recentTopics = [...new Set(recent.slice().reverse().map(attempt => attempt.concept).filter(Boolean))].slice(0, 8);
		const incorrect = recent.filter(attempt => !attempt.correct).length;
		const approximateDifficulty: QuestionDifficulty = recent.length === 0 ? 'easy' :
			incorrect / recent.length > 0.5 ? 'easy' : incorrect / recent.length < 0.2 ? 'hard' : 'medium';

		return { conceptsUnderstood, conceptsFrequentlyMissed, recentTopics, approximateDifficulty };
	}
}
