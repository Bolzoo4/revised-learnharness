// src/core/ext/exams/types.ts
/**
 * Exam training (phase 1) shared types. Contract fixed by
 * docs/superpowers/plans/2026-11-07-exam-training-phase1.md (Contracts):
 * other workstreams import these as they are; change them only with the plan.
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

export interface SearchHit {
	materialId: string;
	title: string;
	page: number;
	text: string;
	score: number;
}

export type SolutionStatus = "exam" | "material" | "derived" | "unverified";
