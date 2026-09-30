import { sanity } from '../sanity.ts';
import { onetUrl } from './data.ts';

export const RIASEC = ['R', 'I', 'A', 'S', 'E', 'C'] as const;
export type RiasecCode = (typeof RIASEC)[number];

const RIASEC_FIELDS: Record<RiasecCode, string> = {
	R: 'realistic',
	I: 'investigative',
	A: 'artistic',
	S: 'social',
	E: 'enterprising',
	C: 'conventional',
};

/** The O*NET Interest Profiler's 5-point response scale. */
export const RATINGS = ['strongly-dislike', 'dislike', 'unsure', 'like', 'strongly-like'] as const;
export type Rating = (typeof RATINGS)[number];
export type QuizRound = 'broad' | 'focused';

const RATING_VALUE: Record<Rating, number> = {
	'strongly-dislike': 0,
	dislike: 0.25,
	unsure: 0.5,
	like: 0.75,
	'strongly-like': 1,
};

/** Area preferences (mean rating value) at or past these count as liked or disliked. */
const LIKED = 0.75;
const DISLIKED = 0.25;

/** Area activities also count toward their parent career types, at this weight. */
const AREA_WEIGHT_FOR_TYPES = 0.5;
const FOCUSED_TYPE_COUNT = 2;
const MAX_FOCUSED_AREAS = 18;
const MATCH_AREA_MIN_SCORE = 3.5;

type InterestDoc = {
	_id: string;
	elementId: string;
	name: string;
	kind: 'careerType' | 'specificArea';
	code: RiasecCode | null;
	description: string | null;
	keywords: string[] | null;
	activities: string[] | null;
	careerTypes: RiasecCode[] | null;
};

type OccupationInterests = {
	code: string;
	title: string;
	jobZone: number | null;
	riasec: Record<string, number>;
	highPoints: string[] | null;
	areas: { ref: string; score: number }[] | null;
};

type Catalog = {
	types: Map<RiasecCode, InterestDoc>;
	areas: InterestDoc[];
	activities: Map<string, { text: string; interest: InterestDoc }>;
};

let catalogPromise: Promise<Catalog> | null = null;
let occupationsPromise: Promise<OccupationInterests[]> | null = null;

/** 47 small documents; cached for the life of the process (restart after re-importing). */
function loadCatalog(): Promise<Catalog> {
	catalogPromise ??= sanity
		.fetch<InterestDoc[]>(
			`*[_type == "onetInterest"] | order(elementId asc){
				_id, elementId, name, kind, code, description,
				"keywords": keywords[].keyword,
				activities,
				"careerTypes": careerTypes[]->code
			}`,
		)
		.then((docs) => {
			const types = new Map<RiasecCode, InterestDoc>();
			const areas: InterestDoc[] = [];
			const activities = new Map<string, { text: string; interest: InterestDoc }>();
			for (const doc of docs) {
				if (doc.kind === 'careerType' && doc.code) types.set(doc.code, doc);
				else areas.push(doc);
				(doc.activities ?? []).forEach((text, i) => activities.set(`${doc.elementId}:${i}`, { text, interest: doc }));
			}
			return { types, areas, activities };
		})
		.catch((error) => {
			catalogPromise = null;
			throw error;
		});
	return catalogPromise;
}

/** RIASEC scores for every occupation (~900 rows). Scanning them in memory avoids a slow GROQ ranking. */
function loadOccupations(): Promise<OccupationInterests[]> {
	occupationsPromise ??= sanity
		.fetch<OccupationInterests[]>(
			`*[_type == "onetOccupation" && defined(interestProfile.riasec)]{
				"code": onetsocCode,
				title,
				"jobZone": jobZone->jobZone,
				"riasec": interestProfile.riasec,
				"highPoints": interestProfile.highPoints,
				"areas": interestProfile.areas[score >= $minScore]{"ref": area._ref, score}
			}`,
			{ minScore: MATCH_AREA_MIN_SCORE },
		)
		.catch((error) => {
			occupationsPromise = null;
			throw error;
		});
	return occupationsPromise;
}

export type ActivityRating = { id: string; rating: Rating };

function shuffle<T>(items: T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function scoreTypes(catalog: Catalog, ratings: ActivityRating[]) {
	const totals = new Map<RiasecCode, { sum: number; weight: number }>(RIASEC.map((c) => [c, { sum: 0, weight: 0 }]));
	const add = (code: RiasecCode, value: number, weight: number) => {
		const t = totals.get(code)!;
		t.sum += value * weight;
		t.weight += weight;
	};
	for (const { id, rating } of ratings) {
		const activity = catalog.activities.get(id);
		if (!activity) continue;
		const value = RATING_VALUE[rating];
		const { interest } = activity;
		if (interest.kind === 'careerType' && interest.code) add(interest.code, value, 1);
		else for (const code of interest.careerTypes ?? []) add(code, value, AREA_WEIGHT_FOR_TYPES);
	}
	return RIASEC.map((code) => {
		const { sum, weight } = totals.get(code)!;
		return { code, score: weight ? round2(1 + 6 * (sum / weight)) : null };
	});
}

function scoreAreas(catalog: Catalog, ratings: ActivityRating[]) {
	const totals = new Map<string, { area: InterestDoc; values: number[] }>();
	for (const { id, rating } of ratings) {
		const activity = catalog.activities.get(id);
		if (!activity || activity.interest.kind !== 'specificArea') continue;
		const entry = totals.get(activity.interest._id) ?? { area: activity.interest, values: [] };
		entry.values.push(RATING_VALUE[rating]);
		totals.set(activity.interest._id, entry);
	}
	return [...totals.values()].map(({ area, values }) => {
		const preference = values.reduce((a, b) => a + b, 0) / values.length;
		return { area, preference, score: round2(1 + 6 * preference) };
	});
}

function rankTypes(scores: ReturnType<typeof scoreTypes>) {
	return scores
		.filter((s): s is { code: RiasecCode; score: number } => s.score != null)
		.sort((a, b) => b.score - a.score || RIASEC.indexOf(a.code) - RIASEC.indexOf(b.code));
}

export async function getQuizActivities(round: QuizRound, ratings: ActivityRating[]) {
	const catalog = await loadCatalog();

	if (round === 'broad') {
		const perType = RIASEC.map((code) => catalog.types.get(code)?.activities ?? []);
		const depth = Math.max(...perType.map((a) => a.length));
		const activities: { id: string; text: string }[] = [];
		for (let i = 0; i < depth; i++) {
			RIASEC.forEach((code, t) => {
				const text = perType[t][i];
				if (text) activities.push({ id: `${catalog.types.get(code)!.elementId}:${i}`, text });
			});
		}
		return { round, activities };
	}

	const ranked = rankTypes(scoreTypes(catalog, ratings));
	if (!ranked.length) {
		return { error: 'No broad-round ratings yet. Run the broad round first.' };
	}
	const focusTypes = ranked.slice(0, FOCUSED_TYPE_COUNT).map((t) => t.code);
	const candidates = catalog.areas
		.map((area) => ({ area, matches: (area.careerTypes ?? []).filter((c) => focusTypes.includes(c)).length }))
		.filter((c) => c.matches > 0 && c.area.activities?.length)
		.sort((a, b) => b.matches - a.matches)
		.slice(0, MAX_FOCUSED_AREAS);

	const activities = shuffle(
		candidates.map(({ area }) => {
			const i = Math.floor(Math.random() * area.activities!.length);
			return { id: `${area.elementId}:${i}`, text: area.activities![i] };
		}),
	);
	return {
		round,
		focusTypes: focusTypes.map((code) => catalog.types.get(code)?.name ?? code),
		activities,
	};
}

export async function buildInterestProfile(ratings: ActivityRating[]) {
	const catalog = await loadCatalog();
	const ranked = rankTypes(scoreTypes(catalog, ratings));
	if (!ranked.length) {
		return { error: 'No activity ratings yet. Run the quiz rounds first.' };
	}

	const areas = scoreAreas(catalog, ratings).sort((a, b) => b.score - a.score);
	return {
		hollandCode: ranked
			.slice(0, 3)
			.map((t) => t.code)
			.join(''),
		ratedActivities: ratings.length,
		types: ranked.map(({ code, score }) => {
			const doc = catalog.types.get(code);
			return {
				code,
				name: doc?.name ?? code,
				score,
				description: doc?.description ?? null,
				keywords: (doc?.keywords ?? []).slice(0, 6),
			};
		}),
		likedAreas: areas.filter((a) => a.preference >= LIKED).map((a) => ({ name: a.area.name, score: a.score })),
		dislikedAreas: areas.filter((a) => a.preference <= DISLIKED).map((a) => a.area.name),
	};
}

/** Pearson correlation of two RIASEC vectors; 0 when either has no spread. */
function correlation(a: number[], b: number[]) {
	const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
	const ma = mean(a);
	const mb = mean(b);
	let num = 0;
	let da = 0;
	let db = 0;
	for (let i = 0; i < a.length; i++) {
		num += (a[i] - ma) * (b[i] - mb);
		da += (a[i] - ma) ** 2;
		db += (b[i] - mb) ** 2;
	}
	return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * Rank occupations by fit with the quiz ratings: 70% correlation of the RIASEC profiles, 30% how
 * much the user liked the occupation's strongest Specific Interest Areas (when the focused round ran).
 */
export async function matchOccupations(ratings: ActivityRating[], limit: number, maxJobZone?: number) {
	const [catalog, occupations] = await Promise.all([loadCatalog(), loadOccupations()]);
	const typeScores = scoreTypes(catalog, ratings);
	if (typeScores.every((t) => t.score == null)) {
		return { error: 'No activity ratings yet. Run the quiz rounds first.' };
	}
	const user = typeScores.map((t) => t.score ?? 1);
	const areaPrefs = new Map(scoreAreas(catalog, ratings).map((a) => [a.area._id, a]));

	const scored = occupations
		.filter((o) => maxJobZone == null || (o.jobZone != null && o.jobZone <= maxJobZone))
		.map((o) => {
			const occ = RIASEC.map((code) => o.riasec[RIASEC_FIELDS[code]] ?? 1);
			const riasecFit = (correlation(user, occ) + 1) / 2;

			let weighted = 0;
			let weights = 0;
			const matchingAreas: string[] = [];
			for (const { ref, score } of o.areas ?? []) {
				const pref = areaPrefs.get(ref);
				if (!pref) continue;
				const w = ((score - 1) / 6) ** 2;
				weighted += w * pref.preference;
				weights += w;
				if (pref.preference >= LIKED && score >= 5) matchingAreas.push(pref.area.name);
			}
			const fit = areaPrefs.size ? 0.7 * riasecFit + 0.3 * (weights > 0.05 ? weighted / weights : 0.5) : riasecFit;
			return { o, fit, matchingAreas };
		})
		.sort((a, b) => b.fit - a.fit)
		.slice(0, limit);

	return {
		maxJobZone: maxJobZone ?? null,
		matches: scored.map(({ o, fit, matchingAreas }) => ({
			code: o.code,
			title: o.title,
			url: onetUrl(o.code),
			jobZone: o.jobZone,
			matchPercent: Math.round(fit * 100),
			interestCode: (o.highPoints ?? [])
				.map((name) => [...catalog.types.values()].find((t) => t.name === name)?.code)
				.filter(Boolean)
				.join(''),
			matchingAreas: matchingAreas.slice(0, 3),
		})),
	};
}
