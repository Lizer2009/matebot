/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@matebot/adapter-kit";
import { ANDROID_APK_URL, onMarketingSite } from "@matebot/contracts";
import { documentOriginFromEnv } from "@matebot/core";
import { Link, Text } from "react-email";
import { emailText, greeting, linkStyle, message } from "./email.js";

/**
 * Download pages live on the deployment's marketing site, so the links are built from its origin
 * rather than a baked host: a self-hosted install that never configured the hosted site must not
 * send its own users to it.
 */
const DOWNLOAD_PATH = "/download/";
const GITHUB_URL = "https://github.com/Lizer2009/matebot";
const SELF_HOST_URL = `${GITHUB_URL}#self-hosting`;

function appLinks(origin: string): Readonly<Record<string, string>> {
  return {
    iPhone: onMarketingSite(origin, "/ios/"),
    Android: ANDROID_APK_URL,
    Mac: onMarketingSite(origin, DOWNLOAD_PATH),
    Windows: onMarketingSite(origin, DOWNLOAD_PATH),
    Linux: onMarketingSite(origin, DOWNLOAD_PATH),
  };
}

export function welcomeEmail(
  user: { email: string; name: string },
  unsubscribeUrl: string,
  locale = "en",
  /** The deployment's marketing origin; defaults to the configured one. */
  marketingOrigin = documentOriginFromEnv(),
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  const APPS = appLinks(marketingOrigin);
  return message(
    user.email,
    locale,
    say("Welcome to Matebot"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>{say("Thanks for signing up for Matebot.")}</Text>
      <Text>
        {say("Matebot also has apps for")}{" "}
        {/* The language's own list ("A, B, and C", "A, B y C"), with each app a link. */}
        {new Intl.ListFormat(locale, { type: "conjunction" })
          .formatToParts(Object.keys(APPS))
          .map((part, index) =>
            part.type === "element" ? (
              <Link key={part.value} href={APPS[part.value]} style={linkStyle}>
                {part.value}
              </Link>
            ) : (
              <span key={`${index}${part.value}`}>{part.value}</span>
            ),
          )}
        .
      </Text>
      <Text>
        {say("Matebot is open source. If you like it,")}{" "}
        <Link href={GITHUB_URL} style={linkStyle}>
          {say("a star on GitHub")}
        </Link>{" "}
        {say("helps others find it.")}
      </Text>
      <Text>
        {say("Want to run it on your own servers?")}{" "}
        <Link href={SELF_HOST_URL} style={linkStyle}>
          {say("Self-host Matebot")}
        </Link>
        .
      </Text>
      <Text>{say("Have any questions? Reply to this email.")}</Text>
    </>,
    unsubscribeUrl,
  );
}
