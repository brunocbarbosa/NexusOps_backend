import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ReportStatus } from '../../generated/prisma/enums';

export class QueryReportsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  perPage: number = 20;

  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;
}
