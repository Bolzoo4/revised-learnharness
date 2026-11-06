/**
 * The lecture player's trace for the session debrief: which slides were
 * viewed, which concepts opened, which in-lecture exercises done. Fire and
 * forget: a failing request never disturbs the lecture. One lecture session
 * id per mounted player; when the server says the session ended (409), the
 * next event starts a new session.
 */

export interface ActivityClient {
	slide(slideId: string): void;
	concept(nodeId: string): void;
	exercise(blockId: string): void;
}

type Post = (body: Record<string, string>) => Promise<{ status: number }>;

const defaultId = (): string => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

export function createLectureActivityClient(opts: { lectureId: string; post?: Post; newId?: () => string }): ActivityClient {
	const post: Post =
		opts.post ??
		((body) => fetch("/api/ext/debriefs/activity", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true }));
	const newId = opts.newId ?? defaultId;
	let sessionId = `lecs_${newId()}`;
	let sent = new Set<string>();

	function send(type: string, field: string, value: string): void {
		const key = `${type}:${value}`;
		if (sent.has(key)) return;
		sent.add(key);
		const attempt = async (retry: boolean): Promise<void> => {
			try {
				const res = await post({ type, sessionId, lectureId: opts.lectureId, [field]: value });
				if (res.status === 409 && retry) {
					sessionId = `lecs_${newId()}`;
					sent = new Set([key]);
					await attempt(false);
				} else if (res.status >= 400 && res.status !== 409) {
					sent.delete(key); // allow a later retry of a transient failure
				}
			} catch {
				sent.delete(key);
			}
		};
		void attempt(true);
	}

	return {
		slide: (id) => send("lecture_view", "slideId", id),
		concept: (id) => send("concept_open", "nodeId", id),
		exercise: (id) => send("exercise_done", "blockId", id),
	};
}
