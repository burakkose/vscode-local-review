import * as assert from 'assert';
import { buildAgentSkill } from '../src/agentSkill';

// Mock ReviewPaths — just needs fsPath on the Uri fields
function mockPaths(base = '/home/user/.vscode/globalStorage/ext') {
    return {
        root: { fsPath: `${base}` } as any,
        state: { fsPath: `${base}/state.json` } as any,
        stateBak: { fsPath: `${base}/state.json.bak` } as any,
        promptMd: { fsPath: `${base}/prompt.md` } as any,
        promptJson: { fsPath: `${base}/prompt.json` } as any,
        responses: { fsPath: `${base}/responses.json` } as any,
        skill: { fsPath: `${base}/SKILL.md` } as any,
    };
}

describe('agentSkill', () => {
    describe('buildAgentSkill', () => {
        it('should contain the skill title', () => {
            const skill = buildAgentSkill(mockPaths());
            assert.ok(skill.includes('# Local Code Review — Agent Skill'));
        });

        it('should include workspace name in title when provided', () => {
            const skill = buildAgentSkill(mockPaths(), { workspaceName: 'my-project' });
            assert.ok(skill.includes('(workspace: my-project)'));
        });

        it('should include the prompt.md path', () => {
            const paths = mockPaths('/test/storage');
            const skill = buildAgentSkill(paths);
            assert.ok(skill.includes('/test/storage/prompt.md'));
        });

        it('should include the prompt.json path', () => {
            const paths = mockPaths('/test/storage');
            const skill = buildAgentSkill(paths);
            assert.ok(skill.includes('/test/storage/prompt.json'));
        });

        it('should include the responses.json path', () => {
            const paths = mockPaths('/test/storage');
            const skill = buildAgentSkill(paths);
            assert.ok(skill.includes('/test/storage/responses.json'));
        });

        it('should convert Windows paths to POSIX', () => {
            const paths = mockPaths('C:\\Users\\dev\\.vscode\\storage');
            const skill = buildAgentSkill(paths);
            assert.ok(skill.includes('C:/Users/dev/.vscode/storage/prompt.md'));
            assert.ok(!skill.includes('C:\\Users'));
        });

        it('should include the replies schema', () => {
            const skill = buildAgentSkill(mockPaths());
            assert.ok(skill.includes('"version": 1'));
            assert.ok(skill.includes('"replies"'));
            assert.ok(skill.includes('"newThreads"'));
            assert.ok(skill.includes('"commentId"'));
        });

        it('should include instructions about what NOT to do', () => {
            const skill = buildAgentSkill(mockPaths());
            assert.ok(skill.includes('What NOT to do'));
        });

        it('should include project instructions when provided', () => {
            const skill = buildAgentSkill(mockPaths(), {
                workspaceName: 'proj',
                projectInstructions: 'Always use semicolons.\nPrefer const over let.',
            });
            assert.ok(skill.includes('## Project-specific guidance'));
            assert.ok(skill.includes('Always use semicolons.'));
            assert.ok(skill.includes('Prefer const over let.'));
        });

        it('should not include project instructions section when not provided', () => {
            const skill = buildAgentSkill(mockPaths());
            assert.ok(!skill.includes('Project-specific guidance'));
        });

        it('should mention the protocol is file-based', () => {
            const skill = buildAgentSkill(mockPaths());
            assert.ok(skill.includes('file-based'));
        });

        it('should mention deduplication by content hash', () => {
            const skill = buildAgentSkill(mockPaths());
            assert.ok(skill.includes('dedupes by content hash'));
        });

        it('should mention that responses file is outside the repo', () => {
            const skill = buildAgentSkill(mockPaths());
            assert.ok(skill.includes('outside the repo on purpose'));
        });

        it('should end with primed confirmation', () => {
            const skill = buildAgentSkill(mockPaths());
            assert.ok(skill.includes('You are now primed'));
        });

        it('should mention trigger word "review"', () => {
            const skill = buildAgentSkill(mockPaths());
            assert.ok(skill.includes('"review"'));
        });

        it('should use "this project" fallback when projectInstructions given without workspaceName', () => {
            const skill = buildAgentSkill(mockPaths(), {
                projectInstructions: 'Custom rule here.',
            });
            assert.ok(skill.includes('this project'));
            assert.ok(skill.includes('Custom rule here.'));
        });
    });
});
