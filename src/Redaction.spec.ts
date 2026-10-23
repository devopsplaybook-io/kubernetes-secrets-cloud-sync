import { maskUrlUserinfo, sanitizeResticOutput } from "./Redaction";

describe("maskUrlUserinfo", () => {
  it("masks user:password in a URL", () => {
    expect(
      maskUrlUserinfo("https://user:secret@example.com/path"),
    ).toBe("https://***@example.com/path");
  });

  it("masks a username-only URL", () => {
    expect(maskUrlUserinfo("https://user@example.com/path")).toBe(
      "https://***@example.com/path",
    );
  });

  it("masks restic backend URLs", () => {
    expect(
      maskUrlUserinfo("s3:https://AKIA:secret@bucket.example.com/repo"),
    ).toBe("s3:https://***@bucket.example.com/repo");
    expect(maskUrlUserinfo("rest:https://user:pass@host:8000/")).toBe(
      "rest:https://***@host:8000/",
    );
  });

  it("masks sftp and async userinfo", () => {
    expect(maskUrlUserinfo("sftp:user@host:/srv/restic-repo")).toBe(
      "sftp:***@host:/srv/restic-repo",
    );
    expect(maskUrlUserinfo("async:user@host:repo")).toBe(
      "async:***@host:repo",
    );
  });

  it("leaves credential-free backends and paths unchanged", () => {
    expect(maskUrlUserinfo("local:/srv/restic-repo")).toBe(
      "local:/srv/restic-repo",
    );
    expect(maskUrlUserinfo("s3:https://bucket.example.com/repo")).toBe(
      "s3:https://bucket.example.com/repo",
    );
    expect(maskUrlUserinfo("b2:bucket:path")).toBe("b2:bucket:path");
    expect(maskUrlUserinfo("")).toBe("");
  });

  it("is idempotent for already-masked URLs", () => {
    expect(maskUrlUserinfo("https://***@example.com/path")).toBe(
      "https://***@example.com/path",
    );
  });

  it("masks multiple URLs in a message", () => {
    expect(
      maskUrlUserinfo(
        "failed https://a:b@first.example.com and s3:https://c:d@second.example.com",
      ),
    ).toBe(
      "failed https://***@first.example.com and s3:https://***@second.example.com",
    );
  });
});

describe("sanitizeResticOutput", () => {
  const repository = "s3:https://user:secret@bucket.example.com/restic";
  const password = "restic-password";
  const options = "--option secret-value";

  it("replaces the repository with its masked form", () => {
    const sanitized = sanitizeResticOutput(
      `Fatal: unable to open repository at ${repository}`,
      { repository },
    );
    expect(sanitized).toBe(
      "Fatal: unable to open repository at s3:https://***@bucket.example.com/restic",
    );
    expect(sanitized).not.toContain("user:secret");
  });

  it("replaces the password and restic options literals", () => {
    const sanitized = sanitizeResticOutput(
      `bad password ${password} with ${options}`,
      { password, options },
    );
    expect(sanitized).toBe("bad password *** with ***");
  });

  it("masks URL userinfo that is not the configured repository", () => {
    const sanitized = sanitizeResticOutput(
      "cannot reach https://other:creds@example.com/repo",
      {},
    );
    expect(sanitized).toBe("cannot reach https://***@example.com/repo");
  });

  it("keeps credential-free text unchanged", () => {
    expect(
      sanitizeResticOutput("repository unavailable", { repository, password }),
    ).toBe("repository unavailable");
    expect(sanitizeResticOutput("", { repository })).toBe("");
  });

  it("handles empty option values", () => {
    expect(
      sanitizeResticOutput("nothing to mask", {
        repository: "",
        password: "",
        options: "",
      }),
    ).toBe("nothing to mask");
  });
});
