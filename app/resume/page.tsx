import Nav from "../components/Nav";
import Footer from "../components/Footer";
import { getAboutEntries, type AboutEntry } from "@/lib/data";

export const dynamic = "force-dynamic";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function formatDate(entry: AboutEntry): string {
  const num = Number(entry.month);
  const monthName =
    !Number.isNaN(num) && num >= 1 && num <= 12
      ? MONTHS[num - 1]
      : entry.month ?? "";

  const datePart =
    monthName && entry.day ? `${monthName} ${entry.day}` : monthName;

  return [datePart, entry.year].filter(Boolean).join(", ");
}

export default async function Resume() {
  const entries = await getAboutEntries();

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        padding: "2rem",
      }}
    >
      <Nav />
      <section style={{ marginTop: "2rem", maxWidth: "640px" }}>
        <p style={{ marginTop: "1rem", lineHeight: 1.6 }}>
          Natalie-Rose Nathan is a Fine Artist, Professional Video Editor and
          Producer, Dancer, and Musician in Los Angeles, California. She
          received her BFA from Otis College of Art and Design
        </p>

        {entries.length > 0 && (
          <ul className="resume-list">
            {entries.map((entry) => {
              const date = formatDate(entry);
              return (
                <li key={entry.id} className="resume-item">
                  <p className="resume-item-heading">
                    {date && <span className="resume-date">{date}</span>}
                    {entry.about_title && (
                      <span className="resume-item-title">
                        {date ? " — " : ""}
                        {entry.about_title}
                      </span>
                    )}
                  </p>
                  {entry.about_content && (
                    <p className="resume-item-content">{entry.about_content}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <Footer />
    </main>
  );
}
