// components/ext/exams-types.ts
/**
 * The exam record shapes the Exams pages read. They mirror src/core/ext/exams/types.ts
 * (the contract). Components may import only the "@/src/core" barrel, which does not
 * export the exam types yet, so the shapes are mirrored here; tests/ext-exams-types.test.ts
 * fails the typecheck when the two drift apart. Delete this file once the barrel exports them.
 */

export interface Collection {
	id: string;
	title: string;
	createdAt: string;
}

export interface ExamDoc {
	id: string;
	collectionId: string;
	title: string;
	documentId: string;
	pages: number;
	reviewed: boolean;
}

export interface Exercise {
	id: string;
	examId: string;
	order: number;
	pageStart: number;
	pageEnd: number;
	text: string;
	solution?: string;
	origin?: "exam";
}

export interface MaterialDoc {
	id: string;
	collectionId: string;
	title: string;
	documentId: string;
	pages: number;
	indexedAt: string;
}
