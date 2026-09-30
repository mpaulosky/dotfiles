// One-off data migration for #152: rename the "Answered" Status to "Accepted" (CONTEXT.md) and replace
// "suggestion" with "issue" in the Status descriptions the seeder wrote. Issues keep their own copy of their Status
// (IssueStatus), so those copies are updated too. Safe to run more than once.
//
// Run it with mongosh against the app's database, for example:
//   mongosh "mongodb://localhost:27017/devissuetracker?authSource=admin" scripts/migrations/152-rename-answered-status.js

// Each seeded Status description, from the exact text the seeder used to write to the text it writes now.
const descriptions = {
	Accepted: {
		legacy: "The suggestion was accepted and the corresponding item was created.",
		current: "The issue was accepted and the corresponding item was created."
	},
	Watching: {
		legacy: "The suggestion is interesting. We are watching to see how much interest there is in it.",
		current: "The issue is interesting. We are watching to see how much interest there is in it."
	},
	Upcoming: {
		legacy: "The suggestion was accepted and it will be released soon.",
		current: "The issue was accepted and it will be released soon."
	},
	Dismissed: {
		legacy: "The suggestion was not something that we are going to undertake.",
		current: "The issue was not something that we are going to undertake."
	}
};

const renamed = db.statuses.updateMany(
	{ status_name: "Answered" },
	{ $set: { status_name: "Accepted" } });
print(`statuses renamed Answered -> Accepted: ${renamed.modifiedCount}`);

const renamedCopies = db.issues.updateMany(
	{ "IssueStatus.StatusName": "Answered" },
	{ $set: { "IssueStatus.StatusName": "Accepted" } });
print(`issue Status copies renamed Answered -> Accepted: ${renamedCopies.modifiedCount}`);

// Only the exact seeded text is replaced, so a description an Admin wrote or edited is kept as it is.
for (const [name, { legacy, current }] of Object.entries(descriptions)) {
	const statuses = db.statuses.updateMany(
		{ status_name: name, status_description: legacy },
		{ $set: { status_description: current } });
	const copies = db.issues.updateMany(
		{ "IssueStatus.StatusName": name, "IssueStatus.StatusDescription": legacy },
		{ $set: { "IssueStatus.StatusDescription": current } });
	print(`${name} descriptions updated: ${statuses.modifiedCount} statuses, ${copies.modifiedCount} issue copies`);
}
